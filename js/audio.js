/*
 * 麦克风采集：把浏览器当成 AudioRecord 用。
 *
 * 三条与手机端一致的原则：
 *   1. 采样率用设备真实值。不向 AudioContext 强塞 44100，而是读回 ctx.sampleRate，
 *      再把它交给分析器——固定 44.1k 的假设会让 48k 设备上的音高整体偏高约 1.5 个半音。
 *   2. 关掉 AGC / 降噪 / 回声消除。它们会改造频谱，而跟谱正是拿频谱和乐谱比对。
 *   3. hop 边界严格对齐 1024 帧。AudioWorklet 只做搬运，不做重采样，
 *      所以送进分析器的每一段都是原始 PCM，与手机端 read() 出来的完全等价。
 */
(function (global) {
  "use strict";

  var AudioConfig = global.PianoDsp.AudioConfig;
  var HOP_SIZE = AudioConfig.HOP_SIZE;

  var WORKLET_URL = "js/pcm-worklet.js";
  var WORKER_URL = "js/analysis-worker.js";

  function ListeningEngine() {
    this.isRunning = false;
    this.sampleRate = 0;
    this.mode = "idle";

    /** 每一帧分析结果，参数与 Android 端 AudioFrame 对齐。 */
    this.onFrame = null;
    /** 电平 / 起音等轻量状态，供电平表使用。 */
    this.onState = null;
    this.onError = null;
    this.onReady = null;

    this._context = null;
    this._stream = null;
    this._source = null;
    this._worklet = null;
    this._processor = null;
    this._sink = null;
    this._worker = null;
    this._generation = 0;
    this._captureAttempt = 0;
    this._workletReady = false;

    this.state = {
      isRunning: false,
      levelDb: AudioConfig.MIN_LEVEL_DB,
      peakDb: AudioConfig.MIN_LEVEL_DB,
      noiseFloorDb: AudioConfig.MIN_LEVEL_DB,
      onsetCount: 0,
      onsetPulse: 0,
      lastOnsetFlux: 0,
      sampleRate: AudioConfig.SAMPLE_RATE,
    };
  }

  ListeningEngine.prototype.isSupported = function () {
    return !!(
      global.navigator &&
      global.navigator.mediaDevices &&
      global.navigator.mediaDevices.getUserMedia
    );
  };

  /**
   * 打开麦克风。返回 true 表示采集已经在跑。
   * 必须在用户手势（点击）里调用，否则浏览器的自动播放策略会挂起 AudioContext。
   */
  ListeningEngine.prototype.prepareModel = async function () {
    global.dispatchEvent(new Event("psf-microphone-start"));
    const stopped = this.stop();
    const attempt = this._captureAttempt;
    await stopped;
    if (attempt !== this._captureAttempt) return false;
    try {
      this._context = new (global.AudioContext || global.webkitAudioContext)();
      const context = this._context;
      await context.resume();
      if (attempt !== this._captureAttempt) return false;
      if (this._context.state !== "running")
        throw Error("请再次点击开始以启用音频");
      this.sampleRate = Math.round(this._context.sampleRate);
      if (!this._startWorker()) {
        await this.stop();
        return false;
      }
      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.reportError("模型准备超时，请检查网络后重试，或使用 MIDI 输入");
          this.stop();
        }, 180000);
        this._modelWait = { resolve, timer };
        this._worker.postMessage({
          type: "prepareModel",
          generation: ++this._generation,
        });
      });
    } catch (error) {
      if (attempt !== this._captureAttempt) return false;
      this.reportError(error.message || String(error));
      await this.stop();
      return false;
    }
  };

  ListeningEngine.prototype.start = async function () {
    global.dispatchEvent(new Event("psf-microphone-start"));
    if (this.isRunning) return true;
    const captureAttempt = ++this._captureAttempt;

    if (!this.isSupported()) {
      this.reportError(
        "当前浏览器不支持麦克风采集，请改用 Chrome / Edge / Safari 的较新版本",
      );
      return false;
    }
    if (!global.isSecureContext) {
      this.reportError(
        "麦克风只能在 HTTPS 或 localhost 下使用，请用安全地址打开本页",
      );
      return false;
    }

    try {
      const capturedStream = await global.navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
      if (captureAttempt !== this._captureAttempt) {
        capturedStream.getTracks().forEach((t) => t.stop());
        return false;
      }
      this._stream = capturedStream;
    } catch (error) {
      if (captureAttempt !== this._captureAttempt) return false;
      this.reportError(describeCaptureError(error));
      return false;
    }

    try {
      this._context =
        this._context ||
        new (global.AudioContext || global.webkitAudioContext)();
    } catch (error) {
      this.releaseStream();
      this.reportError(
        "无法创建音频上下文：" +
          (error && error.message ? error.message : error),
      );
      return false;
    }

    if (this._context.state === "suspended") {
      try {
        await this._context.resume();
      } catch (e) {
        /* 下面统一判定 */
      }
    }
    if (captureAttempt !== this._captureAttempt) return false;
    if (this._context.state !== "running") {
      await this.closeContext();
      this.releaseStream();
      this.reportError("音频上下文被浏览器挂起，请再点一次开始按钮");
      return false;
    }

    /* 真实采样率以 AudioContext 为准，后面所有音高换算都基于它。 */
    this.sampleRate = Math.round(this._context.sampleRate);

    if (!this._startWorker()) {
      await this.closeContext();
      this.releaseStream();
      return false;
    }

    this._source = this._context.createMediaStreamSource(this._stream);
    var started = await this._startWorklet();
    if (captureAttempt !== this._captureAttempt) return false;
    if (!started && !this._startScriptProcessor()) {
      this._stopWorker();
      await this.closeContext();
      this.releaseStream();
      this.reportError("无法启动音频分析管线，请刷新页面后重试");
      return false;
    }

    this.isRunning = true;
    this.state = Object.assign({}, this.state, {
      isRunning: true,
      sampleRate: this.sampleRate,
    });
    this.emitState();
    if (this.onReady) this.onReady(this.sampleRate);
    return true;
  };

  ListeningEngine.prototype._startWorker = function () {
    try {
      this._worker = this._worker || new global.Worker(WORKER_URL);
    } catch (error) {
      this.reportError(
        "无法启动分析线程：" + (error && error.message ? error.message : error),
      );
      return false;
    }
    var self = this;
    this._worker.onmessage = function (event) {
      self._handleWorkerMessage(event.data);
    };
    this._worker.onerror = function (event) {
      self.reportError(
        "分析线程出错：" +
          (event && event.message ? event.message : "未知错误"),
      );
    };
    this._worker.postMessage({
      type: "config",
      sampleRate: this.sampleRate,
      hopSize: HOP_SIZE,
      pitchDetection: this.mode === "calibrate",
    });
    return true;
  };

  ListeningEngine.prototype._stopWorker = function () {
    if (!this._worker) return;
    this._worker.terminate();
    this._worker = null;
  };

  /** 优先 AudioWorklet：它在音频渲染线程上跑，不受主线程卡顿影响。 */
  ListeningEngine.prototype._startWorklet = async function () {
    const context = this._context;
    if (!context.audioWorklet) return false;
    try {
      await context.audioWorklet.addModule(WORKLET_URL);
      if (context !== this._context) return false;
      var node = new global.AudioWorkletNode(context, "pcm-hop", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { hopSize: HOP_SIZE },
      });
      var self = this;
      node.port.onmessage = function (event) {
        self._forwardHop(event.data.hop, event.data.timeMs);
      };
      node.onprocessorerror = function () {
        self.reportError("音频处理节点异常，请刷新页面后重试");
      };
      this._source.connect(node);
      this._worklet = node;
      this._workletReady = true;
      return true;
    } catch (error) {
      if (context !== this._context) return false;
      this._worklet = null;
      this._workletReady = false;
      return false;
    }
  };

  /** 老浏览器（无 AudioWorklet）退回到 ScriptProcessor，bufferSize 正好等于一个 hop。 */
  ListeningEngine.prototype._startScriptProcessor = function () {
    if (!this._context.createScriptProcessor) return false;
    var self = this;
    var processor = this._context.createScriptProcessor(HOP_SIZE, 1, 1);
    processor.onaudioprocess = function (event) {
      var channel = event.inputBuffer.getChannelData(0);
      var hop = new Float32Array(channel.length);
      hop.set(channel);
      self._forwardHop(hop, self._context.currentTime * 1000);
    };
    /* ScriptProcessor 只有在连到输出时才会被驱动，用一个静音增益把它接上。 */
    var sink = this._context.createGain();
    sink.gain.value = 0;
    this._source.connect(processor);
    processor.connect(sink);
    sink.connect(this._context.destination);
    this._processor = processor;
    this._sink = sink;
    return true;
  };

  ListeningEngine.prototype._forwardHop = function (hop, timeMs) {
    if (!this._worker || !hop) return;
    this._worker.postMessage(
      { type: "hop", hop: hop, timeMs: timeMs, queuedAt: Date.now() },
      [hop.buffer],
    );
  };

  ListeningEngine.prototype._handleWorkerMessage = function (payload) {
    if (
      !payload ||
      (payload.generation !== undefined &&
        payload.generation !== this._generation)
    )
      return;
    if (payload.assessment)
      global.dispatchEvent(
        new CustomEvent("psf-assessment", { detail: payload.assessment }),
      );

    if (payload.kind === "error") {
      this.reportError(payload.message);
      this.stop();
      return;
    }
    if (payload.kind === "preparing") {
      if (this.onModeReady) this.onModeReady("preparing", payload.message);
      return;
    }
    if (payload.kind === "modelReady") {
      if (this._modelWait) {
        clearTimeout(this._modelWait.timer);
        this._modelWait.resolve(true);
        this._modelWait = null;
      }
      return;
    }
    if (payload.kind === "frame") {
      this.state = Object.assign({}, this.state, {
        levelDb: payload.levelDb,
        peakDb: payload.peakDb,
        noiseFloorDb: payload.noiseFloorDb,
        onsetPulse: payload.onsetPulse,
        lastOnsetFlux: payload.lastOnsetFlux,
      });
      if (this.onFrame) this.onFrame(payload);
      return;
    }

    if (payload.kind === "follow" || payload.kind === "calibration") {
      if (this.onModeReady) this.onModeReady(payload.kind);
    }
  };

  /** 切到跟谱：把乐谱时间线交给 Worker，之后每帧都会带回游标状态。 */
  ListeningEngine.prototype.startMidiFollowing = function (structure, tick) {
    this.stop();
    this.sampleRate = 44100;
    if (!this._startWorker()) return false;
    this.mode = "follow";
    this._worker.postMessage({
      type: "mode",
      mode: "follow",
      source: "midi",
      generation: ++this._generation,
      structure,
      assessment: !!document.getElementById("assessment-enabled")?.checked,
      seekTick: tick || 0,
    });
    return true;
  };
  ListeningEngine.prototype.finishAssessment = function () {
    this._worker?.postMessage({ type: "assessmentFinish" });
  };
  ListeningEngine.prototype.sendMidiObservation = function (observation) {
    this._worker?.postMessage({ type: "midi", observation });
  };
  ListeningEngine.prototype.startFollowing = function (
    structure,
    bpm,
    seekTick,
  ) {
    this.mode = "follow";
    if (!this._worker) return;
    this._worker.postMessage({
      type: "pitchDetection",
      enabled: false,
    });
    this._worker.postMessage({
      type: "mode",
      mode: "follow",
      generation: ++this._generation,
      assessment: !!document.getElementById("assessment-enabled")?.checked,
      structure: structure,
      bpm: bpm || 100,
      tuningCents: Number(localStorage.getItem("psf-tuning") || 0),
      seekTick: seekTick || 0,
    });
  };

  /** 切到校音：打开基频估计。 */
  ListeningEngine.prototype.startCalibration = function () {
    this.mode = "calibrate";
    if (!this._worker) return;
    this._worker.postMessage({ type: "pitchDetection", enabled: true });
    this._worker.postMessage({
      type: "mode",
      mode: "calibrate",
      generation: ++this._generation,
      storedOffset: Number(localStorage.getItem("psf-tuning") || 0),
      hasStoredOffset: localStorage.getItem("psf-tuning") !== null,
    });
  };

  /** 丢掉已经学到的音高偏移，回到“先弹中央 C”的状态。 */
  ListeningEngine.prototype.resetCalibration = function () {
    if (!this._worker) return;
    this._worker.postMessage({ type: "calibrationReset" });
  };

  ListeningEngine.prototype.stopAnalysis = function () {
    this.mode = "idle";
    if (!this._worker) return;
    this._worker.postMessage({ type: "pitchDetection", enabled: false });
    this._worker.postMessage({
      type: "mode",
      mode: "idle",
      generation: ++this._generation,
    });
  };

  ListeningEngine.prototype.stop = async function () {
    this._captureAttempt++;
    if (this._modelWait) {
      clearTimeout(this._modelWait.timer);
      this._modelWait.resolve(false);
      this._modelWait = null;
    }
    const stoppedGeneration = ++this._generation;
    if (!this.isRunning && !this._context && !this._worker) return;
    this.isRunning = false;

    this._workletReady = false;
    try {
      if (this._processor) {
        this._processor.onaudioprocess = null;
        this._processor.disconnect();
      }
      if (this._worklet) this._worklet.port.onmessage = null;
      if (this._source) this._source.disconnect();
      if (this._sink) this._sink.disconnect();
    } catch (e) {
      /* 断开失败不影响收尾 */
    }
    this._worklet = null;
    this._processor = null;
    this._sink = null;
    this._source = null;

    this._stopWorker();
    this.releaseStream();
    await this.closeContext();
    if (stoppedGeneration !== this._generation) return;

    this.state = Object.assign({}, this.state, {
      isRunning: false,
      levelDb: AudioConfig.MIN_LEVEL_DB,
      peakDb: AudioConfig.MIN_LEVEL_DB,
    });
    this.emitState();
  };

  ListeningEngine.prototype.closeContext = async function () {
    var context = this._context;
    this._context = null;
    if (!context) return;
    try {
      await context.close();
    } catch (e) {
      /* 已经关掉了 */
    }
  };

  ListeningEngine.prototype.releaseStream = function () {
    if (!this._stream) return;
    var tracks = this._stream.getTracks ? this._stream.getTracks() : [];
    for (var i = 0; i < tracks.length; i++) {
      try {
        tracks[i].stop();
      } catch (e) {
        /* 已经停了 */
      }
    }
    this._stream = null;
  };

  ListeningEngine.prototype.emitState = function () {
    if (this.onState) this.onState(this.state);
  };

  ListeningEngine.prototype.reportError = function (message) {
    if (this.onError) this.onError(message);
  };

  function describeCaptureError(error) {
    var name = error && error.name ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      return "麦克风权限被拒绝，请在浏览器地址栏的权限设置里允许本页使用麦克风";
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "没有检测到可用的麦克风设备，请确认设备已连接";
    }
    if (name === "NotReadableError" || name === "TrackStartError") {
      return "麦克风被其他应用占用，请关闭占用它的程序后重试";
    }
    if (name === "OverconstrainedError") {
      return "麦克风不支持所需的采样格式，请换一个输入设备";
    }
    return (
      "无法打开麦克风：" + (error && error.message ? error.message : "未知原因")
    );
  }

  global.PianoAudio = {
    ListeningEngine: ListeningEngine,
    HOP_SIZE: HOP_SIZE,
  };
})(window);
