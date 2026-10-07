/*
 * 校音引擎 —— 由 Android 端 CalibrationEngine.kt 移植。
 *
 * 先让用户弹一次中央 C 学会整台琴的音高偏移（以音分为单位，天然与八度无关），
 * 之后弹哪个音就显示哪个音，并给出相对十二平均律的音分偏差。
 */
(function (global) {
    'use strict';

    var CalibrationPhase = { Idle: 'Idle', AwaitingReference: 'AwaitingReference', Ready: 'Ready' };

    var C4_HZ = 261.6256;
    var SOUND_MARGIN_DB = 6;
    var MIN_SOUND_LEVEL_DB = -60;
    var MIN_CONFIDENCE_DISPLAY = 0.22;
    var MIN_CONFIDENCE_REFERENCE = 0.45;
    var REFERENCE_TOLERANCE_CENTS = 60;
    var MAX_REFERENCE_SPREAD_CENTS = 45;
    var MIN_MIDI = 21;
    var MAX_MIDI = 108;
    var REFERENCE_SAMPLES = 8;

    var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    function frequencyOf(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }
    function midiOf(hz) { return Math.round(69 + 12 * Math.log2(hz / 440)); }
    function noteName(midi) { return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1); }
    function noteNameOf(hz) { return noteName(midiOf(hz)); }
    function centsToRatio(cents) { return Math.pow(2, cents / 1200); }

    function CalibrationEngine() {
        this.readings = [];
        this.offsetCents = 0;
        this.hasCalibration = false;
        this.state = emptyState();
    }

    function emptyState() {
        return {
            isRunning: false,
            phase: CalibrationPhase.Idle,
            offsetCents: 0,
            hasCalibration: false,
            noteName: '',
            pitchClass: -1,
            octave: -1,
            frequencyHz: 0,
            correctedHz: 0,
            centsDeviation: 0,
            midiNote: -1,
            confidence: 0,
            collected: 0,
            referenceSamples: REFERENCE_SAMPLES,
            isSounding: false,
            message: null
        };
    }

    CalibrationEngine.prototype.start = function () {
        this.readings = [];
        this.state = Object.assign(this.state, {
            isRunning: true,
            phase: this.hasCalibration ? CalibrationPhase.Ready : CalibrationPhase.AwaitingReference,
            offsetCents: this.offsetCents,
            hasCalibration: this.hasCalibration,
            collected: 0,
            isSounding: false,
            message: this.hasCalibration ? null : '请先弹奏中央 C，校准你的钢琴'
        });
    };

    CalibrationEngine.prototype.stop = function () {
        this.readings = [];
        this.state = Object.assign(this.state, { isRunning: false, isSounding: false, collected: 0 });
    };

    CalibrationEngine.prototype.reset = function () {
        this.readings = [];
        this.offsetCents = 0;
        this.hasCalibration = false;
        this.state = Object.assign(this.state, {
            phase: this.state.isRunning ? CalibrationPhase.AwaitingReference : CalibrationPhase.Idle,
            offsetCents: 0,
            hasCalibration: false,
            noteName: '',
            pitchClass: -1,
            octave: -1,
            frequencyHz: 0,
            correctedHz: 0,
            centsDeviation: 0,
            midiNote: -1,
            confidence: 0,
            collected: 0,
            isSounding: false,
            message: this.state.isRunning ? '请先弹奏中央 C，校准你的钢琴' : null
        });
    };

    CalibrationEngine.prototype.onFrame = function (frame) {
        var current = this.state;
        if (!current.isRunning) return;

        var sounding = frame.levelDb >= frame.noiseFloorDb + SOUND_MARGIN_DB &&
            frame.levelDb >= MIN_SOUND_LEVEL_DB;
        var voiced = sounding && frame.pitchHz > 0 && frame.pitchConfidence >= MIN_CONFIDENCE_DISPLAY;

        if (!voiced) {
            // 半截的参考读数不能留到下一次尝试：用户可能中途松手又敲了别的键。
            if (this.readings.length) this.readings = [];
            Object.assign(current, { isSounding: false, collected: 0 });
            return;
        }

        var message = current.message;
        var phase = current.phase;

        if (phase === CalibrationPhase.AwaitingReference) {
            var semitonesFromC4 = 12 * Math.log2(frame.pitchHz / C4_HZ);
            var nearestSemitone = Math.round(semitonesFromC4);
            // 一个半音是 100 音分，所以残差乘 100，而不是把八度换算成音分的 1200。
            var deviation = 100 * (semitonesFromC4 - nearestSemitone);
            var pitchClass = ((nearestSemitone % 12) + 12) % 12;
            var settled = frame.pitchConfidence >= MIN_CONFIDENCE_REFERENCE;

            if (pitchClass === 0 && Math.abs(deviation) <= REFERENCE_TOLERANCE_CENTS && settled) {
                this.readings.push(deviation);
                if (this.readings.length >= REFERENCE_SAMPLES) {
                    var spread = Math.max.apply(null, this.readings) - Math.min.apply(null, this.readings);
                    if (spread <= MAX_REFERENCE_SPREAD_CENTS) {
                        this.offsetCents = medianOf(this.readings);
                        this.hasCalibration = true;
                        phase = CalibrationPhase.Ready;
                        message = describeOffset(this.offsetCents);
                        this.readings = [];
                    } else {
                        this.readings = [];
                        message = '音高不太稳定，请按住中央 C 再弹一次';
                    }
                } else {
                    message = null;
                }
            } else {
                this.readings = [];
                message = '检测到 ' + noteNameOf(frame.pitchHz) + '，请弹奏中央 C（键盘正中间的那个 C）';
            }
        }

        var correctedHz = frame.pitchHz / centsToRatio(this.offsetCents);
        var midi = midiOf(correctedHz);
        if (midi < MIN_MIDI || midi > MAX_MIDI) {
            Object.assign(current, {
                isSounding: true,
                collected: this.readings.length,
                phase: phase,
                message: '这个音超出了识别范围，请弹奏钢琴键盘上的音'
            });
            return;
        }

        var deviationCents = 1200 * Math.log2(correctedHz / frequencyOf(midi));

        Object.assign(current, {
            phase: phase,
            offsetCents: this.offsetCents,
            hasCalibration: this.hasCalibration,
            isSounding: true,
            noteName: noteName(midi),
            pitchClass: ((midi % 12) + 12) % 12,
            octave: Math.floor(midi / 12) - 1,
            frequencyHz: frame.pitchHz,
            correctedHz: correctedHz,
            centsDeviation: deviationCents,
            midiNote: midi,
            confidence: frame.pitchConfidence,
            collected: this.readings.length,
            message: message
        });
    };

    function describeOffset(cents) {
        if (Math.abs(cents) < 5) return '校准完成：音准很好，与标准音高几乎一致';
        if (cents > 0) return '校准完成：你的钢琴整体偏高 ' + Math.round(cents) + ' 音分，已自动补偿';
        return '校准完成：你的钢琴整体偏低 ' + Math.round(-cents) + ' 音分，已自动补偿';
    }

    function medianOf(values) {
        var sorted = values.slice().sort(function (a, b) { return a - b; });
        var middle = sorted.length >> 1;
        return (sorted.length & 1) === 1 ? sorted[middle] : 0.5 * (sorted[middle - 1] + sorted[middle]);
    }

    global.PianoCalibration = {
        CalibrationEngine: CalibrationEngine,
        CalibrationPhase: CalibrationPhase,
        NOTE_NAMES: NOTE_NAMES,
        noteName: noteName,
        frequencyOf: frequencyOf,
        midiOf: midiOf
    };
})(window);
