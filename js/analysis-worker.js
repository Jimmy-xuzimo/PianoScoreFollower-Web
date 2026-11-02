/*
 * 分析 Worker：把移植过来的 DSP / 跟谱 / 校音全部放在主线程之外跑。
 *
 * 手机端是在一条 URGENT_AUDIO 线程上做分析的；网页端没有线程优先级可设，
 * 但用 Worker 能达到同样效果——主线程负责渲染与交互，频谱、起音、音级、
 * 基频与对齐都在这里算完，避免任何一帧因为主线程忙而被推迟。
 */
"use strict";

/* 三个模块都是以 window 为全局对象写的 IIFE，Worker 里没有 window，先补上。 */
self.window = self;
importScripts(
  "dsp.js",
  "follower.js",
  "calibration.js",
  "core/tempo-pitch.js",
  "core/score-follower.js",
  "core/piano-stream.js",
  "core/assessment.js",
);
var model = null,
  modelPromise = null,
  stream = null,
  scoreFollower = null,
  assessment = null,
  inputSource = "microphone",
  version = 0,
  neuralActive = false,
  smoothedDb = -72;
function loadModel() {
  if (!modelPromise)
    modelPromise = (async () => {
      delete self.window; // Legacy DSP imports are already bound; keep real Worker detection.
      importScripts(
        "../vendor/tf-core.min.js",
        "../vendor/tf-backend-cpu.min.js",
        "../vendor/tf-tflite.min.js",
      );
      await tf.setBackend("cpu");
      await tf.ready();
      tflite.setWasmPath("../vendor/");
      const response = await fetch(
        "../assets/models/onsets_frames_wavinput_uni.tflite",
      );
      if (!response.ok) throw Error("下载失败（HTTP " + response.status + "）");
      const total = Number(response.headers.get("Content-Length")) || 97684256;
      const reader = response.body?.getReader();
      let buffer;
      if (reader) {
        const chunks = [];
        let received = 0,
          last = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (performance.now() - last > 250) {
            last = performance.now();
            self.postMessage({
              kind: "preparing",
              message:
                "下载钢琴模型 " +
                Math.min(100, Math.round((received / total) * 100)) +
                "% · 首次约 98 MB，可取消",
            });
          }
        }
        const bytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        chunks.length = 0;
        buffer = bytes.buffer;
      } else buffer = await response.arrayBuffer();
      self.postMessage({
        kind: "preparing",
        message: "正在初始化钢琴识别，完成后才会打开麦克风…",
      });
      model = await tflite.loadTFLiteModel(buffer, { numThreads: 1 });
      return model;
    })().catch((e) => {
      modelPromise = null;
      throw e;
    });
  return modelPromise;
}

let outputGeneration = 0;
const nativePost = self.postMessage.bind(self);
self.postMessage = function (data) {
  nativePost({ ...data, generation: outputGeneration });
};
var AudioConfig = self.PianoDsp.AudioConfig;

var analyzer = null;
var engine = null;
var calibration = null;
var dummyListener = { frameListener: null };

var sampleRate = AudioConfig.SAMPLE_RATE;
var hopSize = AudioConfig.HOP_SIZE;
var mode = "idle";
var pitchDetection = false;
var onsetPulse = 0;
var lastOnsetFlux = 0;

function buildAnalyzer() {
  analyzer = new self.PianoDsp.AudioAnalyzer(
    hopSize,
    AudioConfig.FFT_SIZE,
    sampleRate,
  );
  analyzer.pitchDetectionEnabled = pitchDetection;
}

self.onmessage = async function (event) {
  var data = event.data;
  if (!data || typeof data.type !== "string") return;

  switch (data.type) {
    case "prepareModel": {
      const token = ++version;
      outputGeneration = data.generation || 0;
      mode = "preparing";
      self.postMessage({
        kind: "preparing",
        message: "正在准备钢琴模型，暂未开启麦克风…",
      });
      try {
        await loadModel();
        if (token === version) {
          mode = "idle";
          self.postMessage({ kind: "modelReady" });
        }
      } catch (e) {
        if (token === version)
          self.postMessage({
            kind: "error",
            message: "钢琴模型准备失败：" + e.message,
          });
      }
      break;
    }
    case "config":
      if (data.hopSize) hopSize = data.hopSize;
      if (data.sampleRate) sampleRate = data.sampleRate;
      if (typeof data.pitchDetection === "boolean")
        pitchDetection = data.pitchDetection;
      buildAnalyzer();
      break;

    case "pitchDetection":
      pitchDetection = !!data.enabled;
      if (analyzer) analyzer.pitchDetectionEnabled = pitchDetection;
      break;

    case "mode":
      outputGeneration = data.generation || 0;
      if (data.mode === "follow") {
        const token = ++version;
        inputSource = data.source || "microphone";
        mode = "preparing";
        self.postMessage({ kind: "preparing" });
        try {
          if (data.source !== "midi") await loadModel();
          if (token !== version) return;
          neuralActive = false;
          smoothedDb = -72;
          stream =
            data.source === "midi"
              ? null
              : new ScoreFollowCore.PianoStream(
                  model,
                  sampleRate,
                  data.tuningCents || 0,
                );
          scoreFollower = new ScoreFollowCore.ScoreFollower(
            ScoreFollowCore.graph(data.structure),
            data.seekTick || 0,
            !!data.automatic,
          );
          assessment = data.assessment
            ? new ScoreFollowCore.Assessment(
                scoreFollower.graph,
                data.seekTick || 0,
              )
            : null;
          mode = "follow";
          self.postMessage({ kind: "follow" });
        } catch (e) {
          if (token !== version) return;
          self.postMessage({
            kind: "error",
            message: "钢琴模型加载失败：" + e.message,
          });
        }
      } else {
        version++;
        setMode(data);
      }
      break;

    case "calibrationReset":
      if (calibration) calibration.reset();
      break;

    case "assessmentFinish":
      if (assessment)
        self.postMessage({
          kind: "assessment",
          assessment: assessment.finish(),
        });
      break;
    case "midi":
      if (mode === "follow" && inputSource === "midi" && scoreFollower) {
        const o = data.observation,
          p = scoreFollower.accept(o);
        if (assessment) assessment.observe(o, p);
        self.postMessage({
          assessment: assessment?.snapshot(),
          kind: "frame",
          levelDb: o.active ? 0 : -72,
          peakDb: 0,
          noiseFloorDb: -72,
          isOnset: o.isAttack,
          chroma: Array(12).fill(0),
          onsetPulse: o.isAttack ? ++onsetPulse : onsetPulse,
          follow: {
            ...p,
            onsetPulse: onsetPulse,
            cursorTick: p.tick,
            confirmedTick: scoreFollower.graph.events[p.eventIndex]?.tick || 0,
            bestSimilarity: p.confidence,
            topPitchClasses: [],
            targetPitchClasses: [],
            isReady: true,
            status: p.status,
          },
        });
      }
      break;
    case "hop":
      handleHop(data);
      break;
  }
};

function setMode(data) {
  mode = data.mode || "idle";

  engine = null;
  if (mode === "calibrate") {
    if (!calibration)
      calibration = new self.PianoCalibration.CalibrationEngine();
    if (
      data.hasStoredOffset &&
      Number.isFinite(data.storedOffset) &&
      Math.abs(data.storedOffset) <= 100
    ) {
      calibration.offsetCents = data.storedOffset;
      calibration.hasCalibration = true;
    }
    calibration.start();
  } else if (calibration) {
    calibration.stop();
  }
}

function findEventIndex(timeline, tick) {
  var events = timeline.events;
  var index = 0;
  for (var i = 0; i < events.length; i++) {
    if (events[i].tick <= tick) index = i;
    else break;
  }
  return index;
}

function handleHop(data) {
  if (mode === "follow" && inputSource === "midi") return;
  if (mode === "preparing") return;
  if (mode === "follow" && data.queuedAt && Date.now() - data.queuedAt > 2000) {
    mode = "idle";
    self.postMessage({
      kind: "error",
      message:
        "本设备分析速度低于实时输入，已暂停以免继续错位。可改用 MIDI 输入。",
    });
    return;
  }
  if (mode === "follow" && stream && scoreFollower) {
    const hop = new Float32Array(data.hop),
      start = performance.now(),
      frames = stream.accept(hop);
    let attack = false,
      p = scoreFollower.position,
      chroma = new Float32Array(12),
      active = false;
    for (const n of frames) {
      const isAttack = n.attacks.some((x) => x >= 0.5);
      attack = attack || isAttack;
      active = isAttack || n.pitches.some((x) => x >= 0.5);
      neuralActive = active;
      const observation = {
        timeMs: n.availableTimeMs,
        pitches: n.pitches,
        attacks: n.attacks,
        isAttack,
        active,
        analysisLatencyMs: n.availableTimeMs - n.onsetTimeMs,
      };
      p = scoreFollower.accept(observation);
      if (assessment) assessment.observe(observation, p);
      n.pitches.forEach((x, i) => {
        if (x >= 0.5) chroma[i % 12] += x;
      });
    }

    let sum = 0;
    for (const x of hop) sum += x * x;
    const db = 10 * Math.log10(Math.max(1e-12, sum / hop.length));
    smoothedDb += (db - smoothedDb) * (db > smoothedDb ? 0.55 : 0.12);
    p = scoreFollower.advance(
      ((stream.sourceIndex + 1) * 1000) / sampleRate,
      neuralActive && smoothedDb >= -65,
    );
    if (attack) onsetPulse++;
    self.postMessage({
      assessment: assessment?.snapshot(),
      kind: "frame",
      timeMs: data.timeMs,
      levelDb: db,
      peakDb: db,
      noiseFloorDb: -72,
      isOnset: attack,
      flux: 0,
      onsetPulse,
      lastOnsetFlux: 0,
      chroma: Array.from(chroma),
      pitchHz: 0,
      pitchConfidence: 0,
      inferenceMs: performance.now() - start,
      follow: {
        ...p,
        confirmedTick: scoreFollower.graph.events[p.eventIndex]?.tick || 0,
        onsetPulse: onsetPulse,
        cursorTick: p.tick,
        bestSimilarity: p.confidence,
        topPitchClasses: Array.from(chroma.keys()).filter(
          (i) => chroma[i] > 0.5,
        ),
        targetPitchClasses: (
          scoreFollower.graph.events[p.eventIndex]?.pitches || []
        ).map((n) => n % 12),
        isReady: true,
        status: p.status,
      },
    });
    return;
  }
  if (!analyzer) return;

  var hop = new Float32Array(data.hop);
  var frame = analyzer.accept(hop);
  if (frame.isOnset) {
    onsetPulse++;
    lastOnsetFlux = frame.flux;
  }

  var payload = {
    kind: "frame",
    timeMs: data.timeMs,
    levelDb: frame.levelDb,
    peakDb: frame.peakDb,
    noiseFloorDb: frame.noiseFloorDb,
    isOnset: frame.isOnset,
    flux: frame.flux,
    onsetPulse: onsetPulse,
    lastOnsetFlux: lastOnsetFlux,
    chroma: Array.prototype.slice.call(frame.chroma),
    pitchHz: frame.pitchHz,
    pitchConfidence: frame.pitchConfidence,
  };

  if (mode === "follow" && engine) {
    engine.onFrame(frame);
    var state = engine.state;
    payload.follow = {
      cursorTick: state.cursorTick,
      measure: state.measure,
      confidence: state.confidence,
      bestSimilarity: state.bestSimilarity,
      topPitchClasses: state.topPitchClasses,
      targetPitchClasses: state.targetPitchClasses,
      isReady: state.isReady,
    };
  } else if (mode === "calibrate" && calibration) {
    calibration.onFrame(frame);
    payload.calibration = Object.assign({}, calibration.state);
  }

  self.postMessage(payload);
}
