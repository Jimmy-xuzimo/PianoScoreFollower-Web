/*
 * 分析 Worker：把移植过来的 DSP / 跟谱 / 校音全部放在主线程之外跑。
 *
 * 手机端是在一条 URGENT_AUDIO 线程上做分析的；网页端没有线程优先级可设，
 * 但用 Worker 能达到同样效果——主线程负责渲染与交互，频谱、起音、音级、
 * 基频与对齐都在这里算完，避免任何一帧因为主线程忙而被推迟。
 */
'use strict';

/* 三个模块都是以 window 为全局对象写的 IIFE，Worker 里没有 window，先补上。 */
self.window = self;
importScripts('dsp.js', 'follower.js', 'calibration.js');

var AudioConfig = self.PianoDsp.AudioConfig;

var analyzer = null;
var engine = null;
var calibration = null;
var dummyListener = { frameListener: null };

var sampleRate = AudioConfig.SAMPLE_RATE;
var hopSize = AudioConfig.HOP_SIZE;
var mode = 'idle';
var pitchDetection = false;
var onsetPulse = 0;
var lastOnsetFlux = 0;

function buildAnalyzer() {
    analyzer = new self.PianoDsp.AudioAnalyzer(hopSize, AudioConfig.FFT_SIZE, sampleRate);
    analyzer.pitchDetectionEnabled = pitchDetection;
}

self.onmessage = function (event) {
    var data = event.data;
    if (!data || typeof data.type !== 'string') return;

    switch (data.type) {
        case 'config':
            if (data.hopSize) hopSize = data.hopSize;
            if (data.sampleRate) sampleRate = data.sampleRate;
            if (typeof data.pitchDetection === 'boolean') pitchDetection = data.pitchDetection;
            buildAnalyzer();
            break;

        case 'pitchDetection':
            pitchDetection = !!data.enabled;
            if (analyzer) analyzer.pitchDetectionEnabled = pitchDetection;
            break;

        case 'mode':
            setMode(data);
            break;

        case 'calibrationReset':
            if (calibration) calibration.reset();
            break;

        case 'hop':
            handleHop(data);
            break;
    }
};

function setMode(data) {
    mode = data.mode || 'idle';

    if (mode === 'follow') {
        var timeline = self.PianoFollower.buildTimeline(data.structure);
        engine = new self.PianoFollower.FollowerEngine();
        engine.attach(dummyListener, timeline, data.bpm || 100);
        if (data.seekTick > 0) {
            engine.follower.position = findEventIndex(timeline, data.seekTick);
            engine.follower.matchedTick = data.seekTick;
            engine.follower.lastMeasure = timeline.events[engine.follower.position]
                ? timeline.events[engine.follower.position].measure
                : 0;
        }
        onsetPulse = 0;
    } else {
        engine = null;
    }

    if (mode === 'calibrate') {
        if (!calibration) calibration = new self.PianoCalibration.CalibrationEngine();
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
    if (!analyzer) return;

    var hop = new Float32Array(data.hop);
    var frame = analyzer.accept(hop);
    if (frame.isOnset) {
        onsetPulse++;
        lastOnsetFlux = frame.flux;
    }

    var payload = {
        kind: 'frame',
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
        pitchConfidence: frame.pitchConfidence
    };

    if (mode === 'follow' && engine) {
        engine.onFrame(frame);
        var state = engine.state;
        payload.follow = {
            cursorTick: state.cursorTick,
            measure: state.measure,
            confidence: state.confidence,
            bestSimilarity: state.bestSimilarity,
            topPitchClasses: state.topPitchClasses,
            targetPitchClasses: state.targetPitchClasses,
            isReady: state.isReady
        };
    } else if (mode === 'calibrate' && calibration) {
        calibration.onFrame(frame);
        payload.calibration = Object.assign({}, calibration.state);
    }

    self.postMessage(payload);
}
