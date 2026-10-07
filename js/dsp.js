/*
 * 音频数字信号处理层 —— 由 Android 端 Kotlin 实现逐行移植。
 *
 * 保持与原生完全一致的算法，是网页端跟谱精度与手机端一致的前提：
 * 同样的 2048 点起音检测窗、8192 点音级（chroma）窗、谐波积谱基频估计，
 * 以及相同的门限、平滑系数与延迟补偿。
 */
(function (global) {
    'use strict';

    var AudioConfig = {
        SAMPLE_RATE: 44100,
        SUPPORTED_SAMPLE_RATES: [44100, 48000],
        HOP_SIZE: 1024,
        FFT_SIZE: 2048,
        CHROMA_FFT_SIZE: 8192,
        MIN_LEVEL_DB: -72,
        MAX_LEVEL_DB: -3,
        MIN_ONSET_GAP_MS: 70,

        toDb: function (amplitude) {
            return amplitude <= 1e-7 ? this.MIN_LEVEL_DB
                : 20 * Math.log10(amplitude);
        },

        normalizedLevel: function (db) {
            return clamp((db - this.MIN_LEVEL_DB) / (this.MAX_LEVEL_DB - this.MIN_LEVEL_DB), 0, 1);
        }
    };

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    /* ------------------------------------------------------------------ */
    /* 原地迭代基 2 复数 FFT                                                */
    /* ------------------------------------------------------------------ */

    function Fft(size) {
        if (!(size > 1 && (size & (size - 1)) === 0)) throw new Error('FFT size must be a power of two');
        this.size = size;
        this.cosTable = new Float32Array(size / 2);
        this.sinTable = new Float32Array(size / 2);
        this.bitReverse = new Int32Array(size);
        this.magnitude = new Float32Array(size / 2);

        for (var i = 0; i < size / 2; i++) {
            var angle = -2 * Math.PI * i / size;
            this.cosTable[i] = Math.cos(angle);
            this.sinTable[i] = Math.sin(angle);
        }
        var bits = Math.round(Math.log2(size));
        for (var j = 0; j < size; j++) {
            this.bitReverse[j] = reverseBits(j, bits);
        }
    }

    function reverseBits(value, bits) {
        var result = 0;
        for (var i = 0; i < bits; i++) {
            result = (result << 1) | (value & 1);
            value >>= 1;
        }
        return result >>> 0;
    }

    Fft.prototype.forward = function (real, imag) {
        var size = this.size, cosTable = this.cosTable, sinTable = this.sinTable, bitReverse = this.bitReverse;
        for (var i = 0; i < size; i++) {
            var j = bitReverse[i];
            if (j > i) {
                var swap = real[i]; real[i] = real[j]; real[j] = swap;
                swap = imag[i]; imag[i] = imag[j]; imag[j] = swap;
            }
        }

        var length = 2;
        while (length <= size) {
            var half = length >> 1;
            var step = size / length;
            for (var blockStart = 0; blockStart < size; blockStart += length) {
                var twiddle = 0;
                for (var k = blockStart; k < blockStart + half; k++) {
                    var m = k + half;
                    var c = cosTable[twiddle], s = sinTable[twiddle];
                    var tRe = real[m] * c - imag[m] * s;
                    var tIm = real[m] * s + imag[m] * c;
                    real[m] = real[k] - tRe;
                    imag[m] = imag[k] - tIm;
                    real[k] += tRe;
                    imag[k] += tIm;
                    twiddle += step;
                }
            }
            length <<= 1;
        }

        var magnitude = this.magnitude;
        for (var bin = 0; bin < magnitude.length; bin++) {
            magnitude[bin] = Math.hypot(real[bin], imag[bin]);
        }
    };

    /* ------------------------------------------------------------------ */
    /* 音级（chroma）提取                                                   */
    /* ------------------------------------------------------------------ */

    var PITCH_CLASSES = 12;

    function ChromaExtractor(sampleRate, fftSize) {
        sampleRate = sampleRate || AudioConfig.SAMPLE_RATE;
        fftSize = fftSize || AudioConfig.CHROMA_FFT_SIZE;
        this.fftSize = fftSize;
        this.fft = new Fft(fftSize);
        this.window = new Float32Array(fftSize);
        for (var i = 0; i < fftSize; i++) {
            this.window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (fftSize - 1));
        }
        this.real = new Float32Array(fftSize);
        this.imaginary = new Float32Array(fftSize);
        this.binPitchClass = new Int32Array(fftSize / 2).fill(-1);
        this.binWeight = new Float32Array(fftSize / 2);
        this.chroma = new Float32Array(PITCH_CLASSES);

        for (var bin = 1; bin < fftSize / 2; bin++) {
            var frequency = bin * sampleRate / fftSize;
            if (frequency < MIN_FREQUENCY_HZ || frequency > MAX_FREQUENCY_HZ) continue;
            var midi = 69 + 12 * Math.log2(frequency / 440);
            this.binPitchClass[bin] = ((Math.round(midi) % PITCH_CLASSES) + PITCH_CLASSES) % PITCH_CLASSES;
            this.binWeight[bin] = clamp(Math.sqrt(REFERENCE_HZ / frequency), MIN_WEIGHT, MAX_WEIGHT);
        }
    }

    ChromaExtractor.prototype.getSpectrum = function () { return this.fft.magnitude; };

    ChromaExtractor.prototype.extract = function (samples) {
        var fftSize = this.fftSize, real = this.real, imaginary = this.imaginary, window = this.window;
        for (var i = 0; i < fftSize; i++) {
            real[i] = samples[i] * window[i];
            imaginary[i] = 0;
        }
        this.fft.forward(real, imaginary);

        var magnitude = this.fft.magnitude;
        var peak = 0;
        for (var bin = 1; bin < fftSize / 2; bin++) {
            if (this.binPitchClass[bin] >= 0 && magnitude[bin] > peak) peak = magnitude[bin];
        }
        var floor = peak * FLOOR_RATIO;

        var chroma = this.chroma;
        chroma.fill(0);
        for (var b = 1; b < fftSize / 2; b++) {
            var pitchClass = this.binPitchClass[b];
            if (pitchClass < 0) continue;
            var excess = magnitude[b] - floor;
            if (excess <= 0) continue;
            chroma[pitchClass] += Math.sqrt(excess) * this.binWeight[b];
        }

        // 去掉宽带基座再归一化：房间底噪与踏板共振会把每个音级一起抬高，
        // 减去均值后单音接近 one-hot、和弦保留全部成员、噪声归零。
        var mean = 0;
        for (var c = 0; c < PITCH_CLASSES; c++) mean += chroma[c];
        mean /= PITCH_CLASSES;

        var sumSquares = 0;
        for (var d = 0; d < PITCH_CLASSES; d++) {
            var contrast = chroma[d] - mean;
            if (contrast < 0) contrast = 0;
            chroma[d] = contrast;
            sumSquares += contrast * contrast;
        }
        if (sumSquares > 0) {
            var inverse = 1 / Math.sqrt(sumSquares);
            for (var e = 0; e < PITCH_CLASSES; e++) chroma[e] *= inverse;
        }
        return chroma;
    };

    var MIN_FREQUENCY_HZ = 55.0;
    var MAX_FREQUENCY_HZ = 2093.0;
    var FLOOR_RATIO = 1e-3;
    var REFERENCE_HZ = 440.0;
    var MIN_WEIGHT = 0.35;
    var MAX_WEIGHT = 3.0;

    /* ------------------------------------------------------------------ */
    /* 谱通量起音检测                                                       */
    /* ------------------------------------------------------------------ */

    function OnsetDetector(hopSize, fftSize, sampleRate) {
        hopSize = hopSize || AudioConfig.HOP_SIZE;
        fftSize = fftSize || AudioConfig.FFT_SIZE;
        sampleRate = sampleRate || AudioConfig.SAMPLE_RATE;

        this.hopSize = hopSize;
        this.fftSize = fftSize;
        this.fft = new Fft(fftSize);
        this.window = new Float32Array(fftSize);
        for (var i = 0; i < fftSize; i++) {
            this.window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (fftSize - 1));
        }
        this.real = new Float32Array(fftSize);
        this.imaginary = new Float32Array(fftSize);
        this.previousMagnitude = new Float32Array(fftSize / 2);

        this.history = new Float32Array(HISTORY_SIZE);
        this.sortScratch = new Float32Array(HISTORY_SIZE);
        this.historyCount = 0;
        this.historyCursor = 0;

        this.frameIndex = 0;
        this.lastOnsetFrame = -1000;
        this.previousFlux = 0;

        this.refractoryFrames = Math.max(1,
            Math.floor((sampleRate * AudioConfig.MIN_ONSET_GAP_MS) / 1000 / hopSize));
    }

    OnsetDetector.prototype.getSpectrum = function () { return this.fft.magnitude; };

    OnsetDetector.prototype.reset = function () {
        this.previousMagnitude.fill(0);
        this.historyCount = 0;
        this.historyCursor = 0;
        this.frameIndex = 0;
        this.lastOnsetFrame = -1000;
        this.previousFlux = 0;
    };

    OnsetDetector.prototype.process = function (windowSamples, gateOpen) {
        var fftSize = this.fftSize, real = this.real, imaginary = this.imaginary, window = this.window;
        for (var i = 0; i < fftSize; i++) {
            real[i] = windowSamples[i] * window[i];
            imaginary[i] = 0;
        }
        this.fft.forward(real, imaginary);

        var magnitude = this.fft.magnitude;
        var previous = this.previousMagnitude;
        var flux = 0;
        for (var bin = 0; bin < fftSize / 2; bin++) {
            var delta = magnitude[bin] - previous[bin];
            if (delta > 0) flux += delta;
            previous[bin] = magnitude[bin];
        }

        var threshold = this.medianOfHistory() * THRESHOLD_MULTIPLIER + THRESHOLD_OFFSET;
        var isOnset = gateOpen &&
            this.frameIndex >= WARMUP_FRAMES &&
            flux > threshold &&
            flux > this.previousFlux &&
            this.frameIndex - this.lastOnsetFrame >= this.refractoryFrames;

        if (isOnset) this.lastOnsetFrame = this.frameIndex;
        this.pushHistory(flux);
        this.previousFlux = flux;
        this.frameIndex++;

        return { flux: flux, threshold: threshold, isOnset: isOnset };
    };

    OnsetDetector.prototype.pushHistory = function (value) {
        this.history[this.historyCursor] = value;
        this.historyCursor = (this.historyCursor + 1) % HISTORY_SIZE;
        if (this.historyCount < HISTORY_SIZE) this.historyCount++;
    };

    OnsetDetector.prototype.medianOfHistory = function () {
        var count = this.historyCount;
        if (count === 0) return 0;
        var scratch = this.sortScratch;
        for (var i = 0; i < count; i++) scratch[i] = this.history[i];
        var sorted = scratch.subarray(0, count).slice().sort();
        var middle = count >> 1;
        return (count & 1) === 1 ? sorted[middle] : 0.5 * (sorted[middle - 1] + sorted[middle]);
    };

    var HISTORY_SIZE = 24;
    var THRESHOLD_MULTIPLIER = 2.2;
    var THRESHOLD_OFFSET = 0.015;
    var WARMUP_FRAMES = 4;

    /* ------------------------------------------------------------------ */
    /* 谐波积谱基频估计（校音用）                                           */
    /* ------------------------------------------------------------------ */

    function PitchDetector(sampleRate, fftSize) {
        this.sampleRate = sampleRate;
        this.fftSize = fftSize;
        this.logSpectrum = new Float32Array(fftSize / 2);
        this.topValues = new Float32Array(CONFIDENCE_PARTIALS);
        this.topBins = new Int32Array(CONFIDENCE_PARTIALS);
    }

    PitchDetector.prototype.estimate = function (magnitude) {
        var fftSize = this.fftSize, sampleRate = this.sampleRate;
        var limit = Math.min(magnitude.length, fftSize / 2);
        if (limit <= 1) return { frequencyHz: 0, confidence: 0 };

        var minBin = Math.max(1, Math.floor((MIN_HZ * fftSize) / sampleRate));
        var maxBin = Math.min(
            Math.floor((MAX_HZ * fftSize) / sampleRate),
            Math.floor((limit - 1) / HARMONICS)
        );
        if (maxBin <= minBin) return { frequencyHz: 0, confidence: 0 };

        var peak = 0;
        for (var bin = 1; bin < limit; bin++) if (magnitude[bin] > peak) peak = magnitude[bin];
        if (peak <= 0) return { frequencyHz: 0, confidence: 0 };

        var floor = peak * SPECTRUM_FLOOR_RATIO;
        var logSpectrum = this.logSpectrum;
        for (var b = 0; b < limit; b++) logSpectrum[b] = Math.log(magnitude[b] + floor);

        var bestBin = minBin;
        var bestScore = this.hpsScore(minBin, limit);
        for (var candidate = minBin + 1; candidate <= maxBin; candidate++) {
            var score = this.hpsScore(candidate, limit);
            if (score > bestScore) { bestScore = score; bestBin = candidate; }
        }

        var chosen = bestBin;
        for (var divisor = 2; divisor <= MAX_SUBHARMONIC_DIVISOR; divisor++) {
            var lower = Math.floor(bestBin / divisor);
            if (lower < minBin) continue;
            // 只有那个分频点本身真有能量时，才可能是被漏掉的真基频。
            // 纯音（基频以下没有分音）在这里几乎为零，于是不会被错误地拉低八度。
            if (magnitude[lower] < peak * SUBHARMONIC_ENERGY_RATIO) continue;
            if (this.hpsScore(lower, limit) >= bestScore - SUBHARMONIC_MARGIN) chosen = lower;
        }

        var frequency = this.refineBin(chosen, limit) * sampleRate / fftSize;
        if (frequency < MIN_HZ || frequency > MAX_HZ) return { frequencyHz: 0, confidence: 0 };

        return { frequencyHz: frequency, confidence: this.harmonicConfidence(magnitude, limit, frequency) };
    };

    /*
     * 基频计两次：否则 f、f/2、f/3… 的谐波积谱完全并列（它们共享同一批谱峰），
     * 而“从低往高、严格大于”的扫描会把纯音判成它自己的低八度甚至低两个八度。
     * 给候选自身的那条谱线额外计一次权，并列就自动倒向真有基频的那一个。
     */
    PitchDetector.prototype.hpsScore = function (bin, limit) {
        var score = this.logSpectrum[bin] * FUNDAMENTAL_WEIGHT;
        for (var harmonic = 1; harmonic <= HARMONICS; harmonic++) {
            var index = bin * harmonic;
            if (index >= limit) break;
            score += this.logSpectrum[index];
        }
        return score;
    };

    PitchDetector.prototype.refineBin = function (bin, limit) {
        if (bin <= 1 || bin + 1 >= limit) return bin;
        var left = this.hpsScore(bin - 1, limit);
        var center = this.hpsScore(bin, limit);
        var right = this.hpsScore(bin + 1, limit);
        var denominator = left - 2 * center + right;
        if (Math.abs(denominator) < 1e-6) return bin;
        var delta = 0.5 * (left - right) / denominator;
        return bin + clamp(delta, -0.5, 0.5);
    };

    PitchDetector.prototype.harmonicConfidence = function (magnitude, limit, f0) {
        var topValues = this.topValues, topBins = this.topBins;
        topValues.fill(0);
        topBins.fill(0);

        for (var bin = 1; bin < limit; bin++) {
            var value = magnitude[bin];
            if (value <= topValues[CONFIDENCE_PARTIALS - 1]) continue;
            var slot = CONFIDENCE_PARTIALS - 1;
            while (slot > 0 && topValues[slot - 1] < value) {
                topValues[slot] = topValues[slot - 1];
                topBins[slot] = topBins[slot - 1];
                slot--;
            }
            topValues[slot] = value;
            topBins[slot] = bin;
        }

        var total = 0, harmonic = 0;
        for (var s = 0; s < CONFIDENCE_PARTIALS; s++) {
            var v = topValues[s];
            if (v <= 0) continue;
            total += v;
            var frequency = topBins[s] * this.sampleRate / this.fftSize;
            var ratio = frequency / f0;
            var nearest = Math.max(1, Math.round(ratio));
            var cents = 1200 * (Math.log(ratio / nearest) / Math.LN2);
            if (Math.abs(cents) <= PARTIAL_TOLERANCE_CENTS) harmonic += v;
        }
        if (total <= 0) return 0;
        return clamp(harmonic / total, 0, 1);
    };

    var MIN_HZ = 27.0;
    var MAX_HZ = 4200;
    var HARMONICS = 4;
    var FUNDAMENTAL_WEIGHT = 1.0;
    var MAX_SUBHARMONIC_DIVISOR = 3;
    var SUBHARMONIC_MARGIN = 0.8;
    var SUBHARMONIC_ENERGY_RATIO = 0.01;
    var SPECTRUM_FLOOR_RATIO = 1e-3;
    var CONFIDENCE_PARTIALS = 6;
    var PARTIAL_TOLERANCE_CENTS = 60;

    /* ------------------------------------------------------------------ */
    /* 采集分析器：把 hop 长度的 PCM 变成电平 / 起音 / 音级 / 基频           */
    /* ------------------------------------------------------------------ */

    function AudioAnalyzer(hopSize, fftSize, sampleRate) {
        hopSize = hopSize || AudioConfig.HOP_SIZE;
        fftSize = fftSize || AudioConfig.FFT_SIZE;
        sampleRate = sampleRate || AudioConfig.SAMPLE_RATE;

        this.hopSize = hopSize;
        this.fftSize = fftSize;
        this.sampleRate = sampleRate;

        this.onsetDetector = new OnsetDetector(hopSize, fftSize, sampleRate);
        this.chromaExtractor = new ChromaExtractor(sampleRate);
        this.pitchDetector = new PitchDetector(sampleRate, AudioConfig.CHROMA_FFT_SIZE);
        this.windowBuffer = new Float32Array(fftSize);
        this.chromaBuffer = new Float32Array(AudioConfig.CHROMA_FFT_SIZE);
        this.pitchDetectionEnabled = false;

        this.onsetDelayHops = Math.max(0, Math.floor(AudioConfig.CHROMA_FFT_SIZE / hopSize / 2));
        this.pendingOnsets = [];

        this.minSignalBin = Math.max(1, Math.floor(MIN_SIGNAL_HZ * fftSize / sampleRate));
        this.maxSignalBin = clamp(Math.floor(MAX_SIGNAL_HZ * fftSize / sampleRate), this.minSignalBin + 1, fftSize / 2);

        this.smoothedDb = AudioConfig.MIN_LEVEL_DB;
        this.peakDb = AudioConfig.MIN_LEVEL_DB;
        this.noiseFloorDb = AudioConfig.MIN_LEVEL_DB;
        this.hasNoiseEstimate = false;
    }

    AudioAnalyzer.prototype.accept = function (hop) {
        var hopSize = this.hopSize, fftSize = this.fftSize;

        this.windowBuffer.copyWithin(0, hopSize, fftSize);
        this.windowBuffer.set(hop, fftSize - hopSize);

        var chromaSize = this.chromaBuffer.length;
        this.chromaBuffer.copyWithin(0, hopSize, chromaSize);
        this.chromaBuffer.set(hop, chromaSize - hopSize);

        var sumSquares = 0;
        for (var i = 0; i < hop.length; i++) sumSquares += hop[i] * hop[i];
        var db = AudioConfig.toDb(Math.sqrt(sumSquares / hop.length));

        this.smoothedDb = db > this.smoothedDb
            ? this.smoothedDb + (db - this.smoothedDb) * ATTACK
            : this.smoothedDb + (db - this.smoothedDb) * RELEASE;
        this.peakDb = Math.max(db, this.peakDb - PEAK_DECAY_DB);

        if (!this.hasNoiseEstimate) {
            this.noiseFloorDb = db;
            this.hasNoiseEstimate = true;
        } else if (db < this.noiseFloorDb) {
            this.noiseFloorDb += (db - this.noiseFloorDb) * NOISE_TRACK_DOWN;
        } else {
            this.noiseFloorDb += (db - this.noiseFloorDb) * NOISE_TRACK_UP;
        }

        var gateOpen = db > this.noiseFloorDb + ONSET_GATE_MARGIN_DB && db > MIN_ONSET_LEVEL_DB;
        var onset = this.onsetDetector.process(this.windowBuffer, gateOpen);

        var peakMagnitude = 0;
        var spectrum = this.onsetDetector.getSpectrum();
        for (var bin = this.minSignalBin; bin < this.maxSignalBin; bin++) {
            if (spectrum[bin] > peakMagnitude) peakMagnitude = spectrum[bin];
        }

        var chroma = this.chromaExtractor.extract(this.chromaBuffer);
        var pitch = this.pitchDetectionEnabled
            ? this.pitchDetector.estimate(this.chromaExtractor.getSpectrum())
            : { frequencyHz: 0, confidence: 0 };

        return {
            levelDb: this.smoothedDb,
            peakDb: this.peakDb,
            noiseFloorDb: this.noiseFloorDb,
            isOnset: this.delayedOnset(onset.isOnset),
            flux: onset.flux,
            peakMagnitude: peakMagnitude,
            chroma: chroma,
            pitchHz: pitch.frequencyHz,
            pitchConfidence: pitch.confidence
        };
    };

    // 起音标记滞后半个 chroma 窗，让它与真正覆盖敲击瞬间的窗对齐。
    AudioAnalyzer.prototype.delayedOnset = function (isOnset) {
        if (this.onsetDelayHops === 0) return isOnset;
        this.pendingOnsets.push(isOnset);
        return this.pendingOnsets.length > this.onsetDelayHops ? this.pendingOnsets.shift() : false;
    };

    var ATTACK = 0.55;
    var RELEASE = 0.12;
    var PEAK_DECAY_DB = 0.55;
    var NOISE_TRACK_DOWN = 0.25;
    var NOISE_TRACK_UP = 0.002;
    var ONSET_GATE_MARGIN_DB = 6;
    var MIN_ONSET_LEVEL_DB = -60;
    var MIN_SIGNAL_HZ = 55.0;
    var MAX_SIGNAL_HZ = 2093.0;

    global.PianoDsp = {
        AudioConfig: AudioConfig,
        Fft: Fft,
        ChromaExtractor: ChromaExtractor,
        OnsetDetector: OnsetDetector,
        PitchDetector: PitchDetector,
        AudioAnalyzer: AudioAnalyzer,
        clamp: clamp
    };
})(window);
