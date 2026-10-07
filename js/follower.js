/*
 * 乐谱跟随算法 —— 由 Android 端 Kotlin 实现逐行移植。
 *
 * 目标：让网页端的跟谱行为与手机端完全一致。
 * 采用“前向移动窗口 + 起音驱动步进”的在线对齐，而不是整段动态规划：
 * 每帧只需要几百次乘加，就能在平板/手机上给出稳定的当前位置。
 */
(function (global) {
    'use strict';

    var clamp = global.PianoDsp.clamp;
    var CHROMA_BINS = 12;

    /** 两个 L2 归一化 chroma 的余弦相似度。 */
    function chromaSimilarity(a, b) {
        if (!a.length || !b.length) return 0;
        var dot = 0, normA = 0, normB = 0;
        var size = Math.min(a.length, b.length);
        for (var i = 0; i < size; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        if (normA <= 0 || normB <= 0) return 0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    /** 弹奏能量落在乐谱事件所含音级上的比例。 */
    function chromaCoverage(measured, target) {
        var size = Math.min(measured.length, target.length);
        var total = 0, inside = 0;
        for (var i = 0; i < size; i++) {
            var energy = measured[i] > 0 ? measured[i] : 0;
            total += energy;
            if (target[i] > 0) inside += energy;
        }
        if (total <= 0) return 0;
        return inside / total;
    }

    /** 音形相似度与音级覆盖率的等权融合。 */
    function chromaMatch(measured, target) {
        return 0.5 * chromaSimilarity(measured, target) + 0.5 * chromaCoverage(measured, target);
    }

    /* ------------------------------------------------------------------ */
    /* 乐谱时间线                                                           */
    /* ------------------------------------------------------------------ */

    function ScoreTimeline(ticksPerQuarter, events, endTick, measureCount) {
        this.ticksPerQuarter = ticksPerQuarter;
        this.events = events;
        this.endTick = endTick;
        this.measureCount = measureCount;
        this._measureBounds = null;
    }

    ScoreTimeline.prototype.isEmpty = function () { return this.events.length === 0; };

    ScoreTimeline.prototype.secondsPerQuarter = function (bpm) { return 60 / bpm; };

    ScoreTimeline.prototype.measureBounds = function () {
        if (this._measureBounds) return this._measureBounds;
        var measureCount = this.measureCount;
        var bounds = new Float64Array(measureCount * 2).fill(-1);

        for (var e = 0; e < this.events.length; e++) {
            var event = this.events[e];
            var measure = event.measure;
            if (measure < 0 || measure >= measureCount) continue;
            var slot = measure * 2;
            if (bounds[slot] < 0 || event.tick < bounds[slot]) bounds[slot] = event.tick;
        }

        for (var m = 0; m < measureCount; m++) {
            var start = bounds[m * 2];
            if (start < 0) continue;
            var next = -1;
            for (var candidate = m + 1; candidate < measureCount; candidate++) {
                if (bounds[candidate * 2] >= 0) { next = bounds[candidate * 2]; break; }
            }
            bounds[m * 2 + 1] = next >= 0 ? next : Math.max(this.endTick, start);
        }
        this._measureBounds = bounds;
        return bounds;
    };

    /** 演奏者在 [measure] 中走到 [tick] 的进度，0..1。无法界定时返回 1。 */
    ScoreTimeline.prototype.progressInMeasure = function (measure, tick) {
        if (measure < 0 || measure >= this.measureCount) return 1;
        var bounds = this.measureBounds();
        var start = bounds[measure * 2];
        var end = bounds[measure * 2 + 1];
        if (start < 0 || end <= start) return 1;
        return clamp((tick - start) / (end - start), 0, 1);
    };

    ScoreTimeline.EMPTY = new ScoreTimeline(960, [], 0, 0);

    /* ------------------------------------------------------------------ */
    /* 在线对齐器                                                           */
    /* ------------------------------------------------------------------ */

    function FollowerConfig() {
        this.searchWindow = 12;
        this.acceptThreshold = 0.5;
        this.confidenceGain = 0.35;
        this.rejectPenalty = 0.2;
        this.confidenceDecayMs = 2500;
    }

    function ScoreFollower(config) {
        this.config = config || new FollowerConfig();
        this.timeline = ScoreTimeline.EMPTY;
        this.position = 0;
        this.matchedTick = 0;
        this.lastMeasure = 0;
        this.lastSimilarity = 0;
        this.confidence = 0;
        this.bpm = 100;
        this.lastMatchAtMs = 0;
        this.lastDecayAtMs = 0;
        /** 上一次起音已经消费掉的事件下标；-1 表示还没匹配过。 */
        this.matchedEventIndex = -1;
    }

    ScoreFollower.prototype.isReady = function () { return !this.timeline.isEmpty(); };
    ScoreFollower.prototype.getSimilarity = function () { return this.lastSimilarity; };
    ScoreFollower.prototype.getConfidence = function () { return this.confidence; };
    ScoreFollower.prototype.getMeasure = function () { return this.lastMeasure; };
    ScoreFollower.prototype.getTick = function () { return this.matchedTick; };

    /** 当前目标事件期望的音级，升序；用于界面上的“目标”读数。 */
    ScoreFollower.prototype.targetPitchClasses = function () {
        if (this.position < 0 || this.position >= this.timeline.events.length) return [];
        var chroma = this.timeline.events[this.position].chroma;
        var result = [];
        for (var i = 0; i < chroma.length; i++) if (chroma[i] > 0) result.push(i);
        return result;
    };

    ScoreFollower.prototype.load = function (timeline) {
        this.timeline = timeline;
        this.reset();
    };

    ScoreFollower.prototype.reset = function () {
        this.position = 0;
        var first = this.timeline.events[0];
        this.matchedTick = first ? first.tick : 0;
        this.lastMeasure = first ? first.measure : 0;
        this.lastSimilarity = 0;
        this.confidence = 0;
        this.lastMatchAtMs = 0;
        this.lastDecayAtMs = 0;
        this.matchedEventIndex = -1;
    };

    ScoreFollower.prototype.setTempo = function (bpm) { if (bpm > 1) this.bpm = bpm; };

    /** 在 [from, to) 里挑出与这一帧最像的乐谱事件。 */
    ScoreFollower.prototype.bestMatch = function (chroma, from, to) {
        var events = this.timeline.events;
        var bestIndex = from;
        var bestScore = -1;
        for (var index = from; index < to; index++) {
            var score = chromaMatch(chroma, events[index].chroma);
            if (score > bestScore) { bestScore = score; bestIndex = index; }
        }
        return { index: bestIndex, score: bestScore };
    };

    /**
     * 送入一帧分析结果。
     * 只有带起音的帧才会推进位置：持续音会让 chroma 基本不变，
     * 若每帧都推进，按住和弦时游标就会跑到演奏者前面。
     */
    ScoreFollower.prototype.onFrame = function (chroma, isOnset, nowMs) {
        if (this.timeline.isEmpty()) return false;

        this.decayConfidence(nowMs);
        if (!isOnset) return false;

        var events = this.timeline.events;
        var windowEnd = Math.min(events.length, this.position + this.config.searchWindow);

        // 上一次起音已经消费掉当前事件了，所以这一次从下一个事件开始找。
        // 少了这一步，“同一个和弦连弹两遍”会因为两个事件 chroma 完全相同
        // 而永远停在第一个上——游标看着像卡住了。
        var start = this.position;
        if (start === this.matchedEventIndex && start + 1 < windowEnd) start++;

        var match = this.bestMatch(chroma, start, windowEnd);
        // 往下走一格找不到可信匹配时，回头把当前事件再确认一次，
        // 免得把同一根弦的重复触键误判成“弹错了”。
        if (match.score < this.config.acceptThreshold && start > this.position) {
            var retry = this.bestMatch(chroma, this.position, start + 1);
            if (retry.score > match.score) match = retry;
        }

        this.lastSimilarity = match.score;

        if (match.score < this.config.acceptThreshold) {
            // 没有可信匹配：这个音不在谱内，宁可降低一点置信度，也不把游标跳到错误小节。
            this.confidence = Math.max(0, this.confidence - this.config.rejectPenalty);
            return false;
        }

        this.position = match.index;
        this.matchedEventIndex = match.index;
        this.matchedTick = events[match.index].tick;
        this.lastMeasure = events[match.index].measure;
        this.confidence = Math.min(1, this.confidence + this.config.confidenceGain);
        return true;
    };

    /** 当前时刻的预测 tick，让游标在两个起音之间继续前进而不是停住。 */
    ScoreFollower.prototype.predictedTick = function (nowMs) {
        if (this.timeline.isEmpty()) return 0;
        var events = this.timeline.events;
        var event = events[this.position];
        if (!event) return 0;
        if (this.lastMatchAtMs === 0) return event.tick;

        var nextTick = this.position + 1 < events.length ? events[this.position + 1].tick : this.timeline.endTick;
        if (nextTick <= event.tick) return event.tick;

        var maxAdvance = Math.floor((nextTick - event.tick) * MAX_EXTRAPOLATION);
        var elapsedSeconds = Math.max(0, nowMs - this.lastMatchAtMs) / 1000;
        var elapsedTicks = Math.floor(elapsedSeconds / this.secondsPerTick());
        return event.tick + clamp(elapsedTicks, 0, maxAdvance);
    };

    ScoreFollower.prototype.onOnsetMatched = function (nowMs) { this.lastMatchAtMs = nowMs; };

    ScoreFollower.prototype.decayConfidence = function (nowMs) {
        if (this.lastDecayAtMs === 0) { this.lastDecayAtMs = nowMs; return; }
        var elapsedMs = nowMs - this.lastDecayAtMs;
        if (elapsedMs <= 0) return;
        this.lastDecayAtMs = nowMs;
        this.confidence *= Math.exp(-elapsedMs / this.config.confidenceDecayMs);
    };

    ScoreFollower.prototype.secondsPerTick = function () {
        return 60 / this.bpm / this.timeline.ticksPerQuarter;
    };

    var MAX_EXTRAPOLATION = 0.6;

    /* ------------------------------------------------------------------ */
    /* 翻页决策                                                             */
    /* ------------------------------------------------------------------ */

    var PageTurnReason = { NONE: 'NONE', ADVANCE: 'ADVANCE', REWIND: 'REWIND' };

    function PageTurnConfig() {
        this.minConfidence = 0.45;
        this.advanceAtProgress = 0.55;
    }

    function PageTurnController(config) {
        this.config = config || new PageTurnConfig();
        this.reset();
    }

    PageTurnController.prototype.reset = function () {
        this.displayedPage = 0;
        this.lastCursorMeasure = -1;
        this.advancedFromPage = -1;
    };

    PageTurnController.prototype.onManualPage = function (page) {
        if (page < 0) return;
        this.displayedPage = page;
        this.advancedFromPage = -1;
    };

    PageTurnController.prototype.onCursor = function (cursorPage, cursorMeasure, pageCount,
                                                     isLastMeasureOfPage, measureProgress, confidence) {
        if (pageCount <= 1 || cursorPage < 0 || cursorPage >= pageCount) {
            return { reason: PageTurnReason.NONE, targetPage: -1 };
        }

        var previousMeasure = this.lastCursorMeasure;
        this.lastCursorMeasure = cursorMeasure;

        // 演奏者倒回了（重来、反复或纠正）：跟着走，不要把他留在错的页上。
        if (previousMeasure >= 0 && cursorMeasure < previousMeasure && cursorPage < this.displayedPage) {
            this.displayedPage = cursorPage;
            this.advancedFromPage = -1;
            return { reason: PageTurnReason.REWIND, targetPage: cursorPage };
        }

        if (!isLastMeasureOfPage) return { reason: PageTurnReason.NONE, targetPage: -1 };
        if (cursorPage === this.advancedFromPage) return { reason: PageTurnReason.NONE, targetPage: -1 };
        if (cursorPage >= pageCount - 1) return { reason: PageTurnReason.NONE, targetPage: -1 };
        if (confidence < this.config.minConfidence) return { reason: PageTurnReason.NONE, targetPage: -1 };
        if (measureProgress < this.config.advanceAtProgress) return { reason: PageTurnReason.NONE, targetPage: -1 };

        this.advancedFromPage = cursorPage;
        this.displayedPage = cursorPage + 1;
        return { reason: PageTurnReason.ADVANCE, targetPage: cursorPage + 1 };
    };

    /* ------------------------------------------------------------------ */
    /* 引擎：把麦克风帧接进对齐器并发布游标状态                              */
    /* ------------------------------------------------------------------ */

    function FollowerEngine() {
        this.follower = new ScoreFollower();
        this.listening = null;
        this.onsetPulse = 0;
        this.onState = null;
        this.state = emptyFollowState();
    }

    function emptyFollowState() {
        return {
            isFollowing: false,
            cursorTick: 0,
            measure: 0,
            confidence: 0,
            chroma: new Array(CHROMA_BINS).fill(0),
            topPitchClasses: [],
            targetPitchClasses: [],
            bestSimilarity: 0,
            isOnset: false,
            onsetPulse: 0,
            isReady: false
        };
    }

    FollowerEngine.prototype.attach = function (listeningEngine, timeline, bpm) {
        this.detach();
        this.follower.load(timeline);
        this.follower.setTempo(bpm);
        this.onsetPulse = 0;

        var self = this;
        this.state = Object.assign(emptyFollowState(), {
            isFollowing: true,
            cursorTick: this.follower.getTick(),
            measure: this.follower.getMeasure(),
            isReady: !timeline.isEmpty()
        });
        this.emit();

        this.listening = listeningEngine;
        listeningEngine.frameListener = function (frame) { self.onFrame(frame); };
    };

    FollowerEngine.prototype.detach = function () {
        if (this.listening) this.listening.frameListener = null;
        this.listening = null;
        this.state = Object.assign(this.state, { isFollowing: false, confidence: 0, isOnset: false });
        this.emit();
    };

    FollowerEngine.prototype.seekToStart = function () {
        this.follower.reset();
        this.state = Object.assign(this.state, {
            cursorTick: this.follower.getTick(),
            measure: this.follower.getMeasure(),
            confidence: 0
        });
        this.emit();
    };

    FollowerEngine.prototype.onFrame = function (frame) {
        var chroma = frame.chroma;
        // chroma 已 L2 归一化，静音时最强 bin 也有约 0.29，
        // 因此“是否真的有声音”只能从电平判断。
        var sounding = frame.levelDb >= frame.noiseFloorDb + DOMINANT_GATE_MARGIN_DB &&
            frame.levelDb >= MIN_DOMINANT_LEVEL_DB;

        var now = Date.now();
        // 只有确实有琴声的起音才拿去对齐：踩踏板、挪椅子之类的机械噪声
        // 也会触发起音检测，但它们不该推动游标。
        var matched = this.follower.onFrame(chroma, frame.isOnset && sounding, now);
        if (matched) {
            this.follower.onOnsetMatched(now);
            this.onsetPulse++;
        }

        this.state = {
            isFollowing: this.state.isFollowing,
            cursorTick: this.follower.predictedTick(now),
            measure: this.follower.getMeasure(),
            confidence: this.follower.getConfidence(),
            chroma: Array.prototype.slice.call(chroma),
            topPitchClasses: sounding ? topPitchClasses(chroma) : [],
            targetPitchClasses: this.follower.targetPitchClasses(),
            bestSimilarity: this.follower.getSimilarity(),
            isOnset: matched,
            onsetPulse: this.onsetPulse,
            isReady: this.state.isReady
        };
        this.emit();
    };

    /**
     * 最响的几个音级，从强到弱。
     * 截断是相对最强音级而非绝对阈值：敲一个钢琴键会带出自身泛音
     * （C 上会有 G、E），固定门限会把一个音报成三个音。
     */
    function topPitchClasses(chroma) {
        var peak = 0;
        for (var i = 0; i < chroma.length; i++) if (chroma[i] > peak) peak = chroma[i];
        if (peak <= 0) return [];

        var cutoff = peak * TOP_PITCH_CLASS_RATIO;
        var result = [];
        for (var c = 0; c < chroma.length; c++) {
            if (chroma[c] >= cutoff) result.push({ index: c, value: chroma[c] });
        }
        result.sort(function (a, b) { return b.value - a.value; });
        return result.slice(0, TOP_PITCH_CLASSES).map(function (item) { return item.index; });
    }

    FollowerEngine.prototype.emit = function () {
        if (this.onState) this.onState(this.state);
    };

    var DOMINANT_GATE_MARGIN_DB = 6;
    var MIN_DOMINANT_LEVEL_DB = -60;
    var TOP_PITCH_CLASSES = 3;
    var TOP_PITCH_CLASS_RATIO = 0.4;

    /* ------------------------------------------------------------------ */
    /* 由 viewer 的 scoreStructure 构建对齐时间线                            */
    /* ------------------------------------------------------------------ */

    function buildTimeline(structure) {
        var events = [];
        var endTick = 0;

        for (var b = 0; b < structure.bars.length; b++) {
            var bar = structure.bars[b];
            for (var i = 0; i < bar.events.length; i++) {
                var event = bar.events[i];
                var chroma = new Float32Array(CHROMA_BINS);
                for (var n = 0; n < event.notes.length; n++) {
                    var pitchClass = event.notes[n];
                    if (pitchClass >= 0 && pitchClass < CHROMA_BINS) chroma[pitchClass] = 1;
                }
                var sumSquares = 0;
                for (var c = 0; c < CHROMA_BINS; c++) sumSquares += chroma[c] * chroma[c];
                if (sumSquares <= 0) continue;
                var inverse = 1 / Math.sqrt(sumSquares);
                for (var k = 0; k < CHROMA_BINS; k++) chroma[k] *= inverse;

                events.push({
                    tick: event.tick,
                    measure: bar.index,
                    chroma: chroma,
                    noteCount: event.notes.length,
                    isMeasureStart: i === 0
                });
                endTick = Math.max(endTick, event.tick + event.duration);
            }
        }

        return new ScoreTimeline(structure.ticksPerQuarter, events, endTick, structure.bars.length);
    }

    global.PianoFollower = {
        ScoreTimeline: ScoreTimeline,
        ScoreFollower: ScoreFollower,
        FollowerConfig: FollowerConfig,
        FollowerEngine: FollowerEngine,
        PageTurnController: PageTurnController,
        PageTurnReason: PageTurnReason,
        chromaMatch: chromaMatch,
        chromaSimilarity: chromaSimilarity,
        chromaCoverage: chromaCoverage,
        buildTimeline: buildTimeline
    };
})(window);
