/*
 * 网页端主控 —— 把平台层、乐谱库、导入器、音频管线、跟谱引擎与校音引擎接到一起。
 *
 * 与手机端一一对应的几件事：
 *   · 跟谱页与滚动谱页合成同一个页面，按导入的文件类型自动切换显示；
 *   · 底部只有一条悬浮控制条，可下滑隐藏、由把手唤出；
 *   · 跟谱面板默认收起，只在屏幕左边缘留一个带监听状态圆点的小箭头；
 *   · 自动翻页沿用 PageTurnController 的决策（提前半页翻，倒回时跟着走）。
 */
(function (global) {
    'use strict';

    var doc = global.document;

    /* ================================================================== */
    /* 小工具                                                              */
    /* ================================================================== */

    function $(id) { return doc.getElementById(id); }

    function icon(id) { return '<svg><use href="#' + id + '"></use></svg>'; }

    function escapeHtml(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function clamp(value, min, max) {
        if (value < min) return min;
        if (value > max) return max;
        return value;
    }

    function formatBytes(bytes) {
        if (!bytes) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    }

    function formatDuration(seconds) {
        var total = Math.max(0, Math.round(seconds || 0));
        var minutes = Math.floor(total / 60);
        var rest = total % 60;
        return (minutes < 10 ? '0' : '') + minutes + ':' + (rest < 10 ? '0' : '') + rest;
    }

    var NOTE_LABELS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    var MIN_LEVEL_DB = -72;

    /* ================================================================== */
    /* 提示条                                                              */
    /* ================================================================== */

    var toastLayer = $('toast-layer');

    function toast(message, tone, durationMs) {
        if (!toastLayer || !message) return;
        var node = doc.createElement('div');
        node.className = 'toast';
        if (tone) node.dataset.tone = tone;
        var glyph = tone === 'error' ? 'i-warning' : (tone === 'warning' ? 'i-warning-tri' : 'i-info');
        node.innerHTML = icon(glyph) + '<span>' + escapeHtml(message) + '</span>';
        toastLayer.appendChild(node);
        setTimeout(function () {
            node.style.transition = 'opacity 200ms ease';
            node.style.opacity = '0';
            setTimeout(function () {
                if (node.parentNode) node.parentNode.removeChild(node);
            }, 220);
        }, durationMs || (tone === 'error' ? 4600 : 2800));
    }

    /* ================================================================== */
    /* 全局状态                                                            */
    /* ================================================================== */

    var settings = new PianoPlatform.Settings();

    var state = {
        screen: 'score',
        activeKind: 'notation',

        notation: null,          /* { id, name, sourceFormat, blob, url } */
        scrollEntry: null,       /* { id, name, pages, durationSeconds, scrollRatio } */
        pageUrls: [],

        viewer: {
            ready: false,
            structure: null,
            pageCount: 0,
            measureCount: 0,
            ticksPerQuarter: 960
        },
        timeline: null,
        pageTurner: new PianoFollower.PageTurnController(),

        follow: {
            active: false,
            cursorTick: 0,
            measure: 0,
            confidence: 0,
            isReady: false
        },
        cursorPage: 0,
        displayedPage: 0,
        isLastMeasureOfPage: false,
        autoPageTurn: true,

        player: {
            soundfont: 'loading',   /* loading | ready | failed */
            playing: false,
            requested: false
        },

        scrollPlay: {
            playing: false,
            elapsed: 0,
            duration: 180,
            lastTs: 0,
            programmatic: false
        },

        tuner: {
            running: false,
            state: null
        },

        expectedPageScroll: -1
    };

    var listening = new PianoAudio.ListeningEngine();

    function hasScore() { return !!(state.notation || state.scrollEntry); }

    /* ================================================================== */
    /* 主题                                                                */
    /* ================================================================== */

    function applyTheme() {
        PianoPlatform.applyTheme(settings.mode, settings.palette);
    }

    function buildThemeControls() {
        var modeGroup = $('theme-mode-group');
        modeGroup.innerHTML = PianoPlatform.THEME_MODES.map(function (mode) {
            return '<button type="button" role="radio" data-mode="' + mode.id + '"' +
                (settings.mode === mode.id ? ' data-selected="true"' : '') + '>' +
                escapeHtml(mode.label) + '</button>';
        }).join('');

        var paletteGroup = $('palette-group');
        paletteGroup.innerHTML = PianoPlatform.PALETTES.map(function (palette) {
            var hue = palette.hue < 0 ? 212 : palette.hue;
            var dot = palette.hue < 0
                ? 'conic-gradient(from 210deg, hsl(212 60% 60%), hsl(268 55% 62%), hsl(172 50% 52%), hsl(38 70% 60%), hsl(336 60% 62%), hsl(212 60% 60%))'
                : 'hsl(' + hue + ' 62% 52%)';
            return '<button class="swatch" type="button" role="radio" data-palette="' + palette.id + '"' +
                (settings.palette === palette.id ? ' data-selected="true"' : '') + '>' +
                '<span class="swatch__dot" style="background:' + dot + '">' +
                (settings.palette === palette.id ? icon('i-check') : '') + '</span>' +
                '<span class="swatch__label">' + escapeHtml(palette.label) + '</span>' +
                '</button>';
        }).join('');

        var hint = $('palette-hint');
        var dynamic = PianoPlatform.PALETTES[0];
        if (hint) {
            hint.textContent = '六套配色与手机端完全一致；浏览器读不到系统壁纸，' +
                '「' + dynamic.label + '」在网页端按' + dynamic.webFallback + '呈现';
        }
    }

    function bindThemeControls() {
        $('theme-mode-group').addEventListener('click', function (event) {
            var button = event.target.closest('button[data-mode]');
            if (!button) return;
            settings.setMode(button.dataset.mode);
            buildThemeControls();
            applyTheme();
        });

        $('palette-group').addEventListener('click', function (event) {
            var button = event.target.closest('button[data-palette]');
            if (!button) return;
            settings.setPalette(button.dataset.palette);
            buildThemeControls();
            applyTheme();
        });
    }

    /* ================================================================== */
    /* 页面切换                                                            */
    /* ================================================================== */

    function showScreen(name) {
        state.screen = name;
        ['score', 'settings', 'tuner'].forEach(function (key) {
            var section = $('screen-' + key);
            if (section) section.dataset.active = (key === name ? 'true' : 'false');
        });
        if (name === 'settings') refreshSettingsScreen();
        if (name !== 'tuner' && state.tuner.running) stopTuner();
    }

    /* ================================================================== */
    /* viewer 桥                                                           */
    /* ================================================================== */

    var viewerFrame = $('viewer');
    var viewerQueue = [];

    function postViewer(method, args) {
        if (!state.viewer.ready) {
            viewerQueue.push({ method: method, args: args || [] });
            return;
        }
        try {
            viewerFrame.contentWindow.postMessage({
                pianoViewer: true,
                method: method,
                args: args || []
            }, '*');
        } catch (e) {
            /* iframe 还没就绪时忽略 */
        }
    }

    function flushViewerQueue() {
        var queued = viewerQueue.slice();
        viewerQueue.length = 0;
        queued.forEach(function (command) { postViewer(command.method, command.args); });
    }

    global.addEventListener('message', function (event) {
        var data = event.data;
        if (!data || typeof data.type !== 'string') return;
        if (event.source !== viewerFrame.contentWindow) return;
        handleViewerEvent(data);
    });

    function handleViewerEvent(data) {
        switch (data.type) {
            case 'viewerReady':
                state.viewer.ready = true;
                flushViewerQueue();
                break;

            case 'scoreLoaded':
                applyScoreInfo(data);
                break;

            case 'scoreStructure':
                onStructure(data);
                break;

            case 'renderFinished':
                state.viewer.pageCount = data.pageCount || 0;
                state.viewer.measureCount = data.measureCount || 0;
                clearLoading();
                updateTopbarButtons();
                updatePositionChip();
                break;

            case 'playerState':
                onPlayerState(data.state);
                break;

            case 'positionChanged':
                onPositionChanged(data);
                break;

            case 'pageChanged':
                onPageChanged(data);
                break;

            case 'error':
                toast(data.message || '乐谱渲染出错', 'error');
                break;
        }
    }

    function applyScoreInfo(info) {
        var title = state.notation ? state.notation.name : '智能曲谱';
        var subtitle = [];
        if (info && info.title) subtitle.push(info.title);
        if (info && info.masterBars) subtitle.push(info.masterBars + ' 小节');
        if (state.notation) {
            subtitle.push(PianoMidi.formatLabel(state.notation.sourceFormat));
        }
        setTitle(title, subtitle.join(' · ') || '已就绪');
    }

    function onStructure(structure) {
        state.viewer.structure = structure;
        state.viewer.ticksPerQuarter = structure.ticksPerQuarter || 960;
        state.timeline = PianoFollower.buildTimeline(structure);
        state.viewer.measureCount = structure.bars ? structure.bars.length : 0;
        state.pageTurner.reset();

        /* 结构变了就把新的时间线交给分析线程，让跟谱从第一小节重新开始。 */
        if (state.follow.active) {
            listening.startFollowing(structure, tempoOf(structure), 0);
            state.follow.cursorTick = 0;
            state.follow.measure = 0;
            state.follow.confidence = 0;
        }
        updatePositionChip();
    }

    function tempoOf(structure) {
        if (structure && structure.bars && structure.bars.length) {
            var tempo = structure.bars[0].tempo;
            if (tempo && tempo > 1) return tempo;
        }
        return 100;
    }

    function onPlayerState(playerState) {
        if (playerState === 'soundfontLoaded' || playerState === 'ready') {
            state.player.soundfont = 'ready';
            if (state.player.requested) {
                clearLoading();
                postViewer('play');
                state.player.requested = false;
            }
        } else if (playerState === 'soundfontFailed') {
            state.player.soundfont = 'failed';
            state.player.requested = false;
            clearLoading();
            toast('音源加载失败，点播放键可重试', 'error');
        } else if (playerState === 'playing') {
            state.player.playing = true;
            clearLoading();
        } else if (playerState === 'paused') {
            state.player.playing = false;
        }
        updatePlayButton();
    }

    function onPositionChanged(data) {
        state.cursorPage = typeof data.page === 'number' ? data.page : 0;
        state.isLastMeasureOfPage = !!data.isLastMeasureOfPage;
        if (typeof data.pageCount === 'number') state.viewer.pageCount = data.pageCount;
        updatePositionChip();

        /* 播放器驱动的翻页：跟谱没在跑的时候才由播放位置来决策。 */
        if (!state.follow.active && state.player.playing) {
            state.follow.measure = typeof data.measure === 'number' ? data.measure : 0;
            evaluatePageTurn(1);
        }
    }

    function onPageChanged(data) {
        state.displayedPage = data.page || 0;
        if (typeof data.pageCount === 'number') state.viewer.pageCount = data.pageCount;
        updatePositionChip();
        if (data.page === state.expectedPageScroll) {
            state.expectedPageScroll = -1;
        } else {
            /* 用户自己滑走的：让翻页器记住这一页，别把人拽回去。 */
            state.pageTurner.onManualPage(data.page);
        }
    }

    function scrollToPage(page) {
        state.expectedPageScroll = page;
        postViewer('scrollToPage', [page]);
    }

    /* ================================================================== */
    /* 自动翻页                                                            */
    /* ================================================================== */

    function evaluatePageTurn(fallbackProgress) {
        if (!state.autoPageTurn || state.activeKind !== 'notation') return;
        if (state.viewer.pageCount <= 1) return;

        var progress = fallbackProgress;
        if (state.timeline && state.follow.active) {
            progress = state.timeline.progressInMeasure(state.follow.measure, state.follow.cursorTick);
        }
        var confidence = state.follow.active ? state.follow.confidence : (state.player.playing ? 1 : 0);

        var decision = state.pageTurner.onCursor(
            state.cursorPage,
            state.follow.measure,
            state.viewer.pageCount,
            state.isLastMeasureOfPage,
            progress,
            confidence
        );
        if (decision.reason !== PianoFollower.PageTurnReason.NONE) {
            scrollToPage(decision.targetPage);
        }
    }

    /* ================================================================== */
    /* 标题 / 加载提示 / 位置读数                                            */
    /* ================================================================== */

    function setTitle(title, subtitle) {
        $('score-title').textContent = title;
        $('score-subtitle').textContent = subtitle || '';
    }

    function setLoading(text) {
        var chip = $('loading-chip');
        $('loading-chip-text').textContent = text;
        chip.hidden = false;
    }

    function clearLoading() {
        $('loading-chip').hidden = true;
    }

    function updatePositionChip() {
        updatePageButtons();
        var chip = $('position-chip');
        if (!chip) return;
        if (state.activeKind !== 'notation' || !state.notation || !state.viewer.measureCount) {
            chip.hidden = true;
            return;
        }
        var parts = [];
        parts.push('第 ' + (state.follow.measure + 1) + ' / ' + state.viewer.measureCount + ' 小节');
        if (state.viewer.pageCount > 1) {
            parts.push('第 ' + (state.displayedPage + 1) + ' / ' + state.viewer.pageCount + ' 页');
        }
        chip.textContent = parts.join(' · ');
        chip.hidden = false;
    }

    function updateTopbarButtons() {
        var modeButton = $('btn-mode');
        var manageButton = $('btn-manage');
        var moreButton = $('btn-more');
        modeButton.hidden = !(state.notation && state.scrollEntry);
        manageButton.hidden = state.activeKind !== 'scroll' || !state.scrollEntry;
        moreButton.hidden = !hasScore();
    }

    /* ================================================================== */
    /* 显示区域切换                                                        */
    /* ================================================================== */

    function showEmptyState(show) {
        $('empty-state').hidden = !show;
    }

    function setActiveKind(kind) {
        state.activeKind = kind;
        var notation = kind === 'notation';
        $('notation-stage').hidden = !notation;
        $('scroll-viewport').hidden = notation;
        if (notation && state.follow.active) {
            /* 回到记谱谱面，重新把时间线交给分析线程。 */
            if (state.viewer.structure) {
                listening.startFollowing(state.viewer.structure, tempoOf(state.viewer.structure), state.follow.cursorTick);
            }
        } else if (!notation && state.follow.active) {
            stopFollowing(true);
        }
        $('score-body').dataset.reserveBar = 'true';
        $('bar-layer').hidden = false;
        buildBar();
        updateTopbarButtons();
        updatePositionChip();
        refreshMicPanel();
    }

    /* ================================================================== */
    /* 记谱乐谱：打开与播放                                                 */
    /* ================================================================== */

    function releaseNotationUrl() {
        if (state.notation && state.notation.url) {
            try { URL.revokeObjectURL(state.notation.url); } catch (e) { /* ignore */ }
        }
    }

    function openNotation(entry) {
        if (!entry || !entry.blob) return;
        releaseNotationUrl();

        state.notation = entry;
        entry.url = URL.createObjectURL(entry.blob);

        state.viewer.structure = null;
        state.viewer.pageCount = 0;
        state.viewer.measureCount = 0;
        state.timeline = null;
        state.pageTurner.reset();
        state.player.soundfont = 'loading';
        state.player.playing = false;
        state.player.requested = false;

        setTitle(entry.name, PianoMidi.formatLabel(entry.sourceFormat) + ' · 正在排版…');
        setActiveKind('notation');
        showEmptyState(false);
        setLoading('乐谱渲染中…');

        postViewer('loadScore', [entry.url]);
        PianoLibrary.rememberLastOpened('notation', entry.id);
    }

    function updatePlayButton() {
        var button = $('btn-play');
        if (!button) return;

        var mode;
        if (state.activeKind === 'scroll') {
            mode = state.scrollPlay.playing ? 'playing' : 'idle';
        } else {
            mode = 'idle';
            if (state.player.soundfont === 'failed') mode = 'failed';
            else if (state.player.playing) mode = 'playing';
            else if (!state.viewer.ready || state.player.soundfont === 'loading') mode = 'loading';
        }

        button.dataset.state = mode;
        button.disabled = (mode === 'loading');
        button.innerHTML = mode === 'loading'
            ? '<span class="play-btn__spinner"></span>'
            : icon(mode === 'playing' ? 'i-pause' : (mode === 'failed' ? 'i-refresh' : 'i-play'));
        button.setAttribute('aria-label',
            mode === 'playing' ? '暂停' : (mode === 'failed' ? '重试音源' : '播放'));
    }

    function togglePlayer() {
        if (state.player.soundfont === 'failed') {
            state.player.soundfont = 'loading';
            updatePlayButton();
            postViewer('retrySoundFont');
            return;
        }
        if (state.player.playing) {
            postViewer('pause');
            return;
        }
        /* 播放器与麦克风跟谱共用同一个游标，同时跑会互相打架。 */
        if (state.follow.active) stopFollowing(true);

        if (state.player.soundfont !== 'ready') {
            state.player.requested = true;
            setLoading('音源加载中…');
            updatePlayButton();
            return;
        }
        postViewer('play');
    }

    /* ================================================================== */
    /* 麦克风跟谱                                                          */
    /* ================================================================== */

    listening.onFrame = function (frame) {
        updateMeter(frame);
        if (frame.follow) applyFollow(frame.follow);
        else if (frame.calibration) applyCalibration(frame.calibration);
    };

    listening.onError = function (message) {
        toast(message, 'error');
        if (state.follow.active) stopFollowing(true);
        if (state.tuner.running) stopTuner();
    };

    listening.onReady = function (sampleRate) {
        var tag = $('mic-sr');
        if (tag) tag.textContent = (sampleRate / 1000).toFixed(1) + ' kHz';
        refreshSettingsScreen();
    };

    var followUiDirty = false;
    var lastCursorPost = 0;

    function applyFollow(follow) {
        state.follow.cursorTick = follow.cursorTick || 0;
        state.follow.measure = follow.measure || 0;
        state.follow.confidence = follow.confidence || 0;
        state.follow.isReady = !!follow.isReady;
        state.follow.lastSimilarity = follow.bestSimilarity || 0;
        state.follow.topPitchClasses = follow.topPitchClasses || [];
        state.follow.targetPitchClasses = follow.targetPitchClasses || [];
        state.follow.onsetPulse = follow.onsetPulse || 0;

        var now = Date.now();
        if (now - lastCursorPost > 45) {
            lastCursorPost = now;
            postViewer('setCursorTick', [state.follow.cursorTick]);
        }

        evaluatePageTurn(1);
        scheduleFollowUi();
    }

    function scheduleFollowUi() {
        if (followUiDirty) return;
        followUiDirty = true;
        global.requestAnimationFrame(function () {
            followUiDirty = false;
            refreshFollowUi();
        });
    }

    function refreshFollowUi() {
        var main = $('bar-main');
        var sub = $('bar-sub');
        var confidence = $('bar-confidence');

        if (main && state.viewer.measureCount) {
            main.textContent = '第 ' + (state.follow.measure + 1) + ' / ' + state.viewer.measureCount + ' 小节';
        }
        if (sub) {
            sub.textContent = state.follow.isReady
                ? '相似度 ' + Math.round((state.follow.lastSimilarity || 0) * 100) + '%'
                : '等待乐谱';
        }
        if (confidence) {
            var percent = Math.round(clamp(state.follow.confidence, 0, 1) * 100);
            confidence.dataset.low = state.follow.confidence < 0.45 ? 'true' : 'false';
            var fill = confidence.firstElementChild;
            if (fill) fill.style.width = percent + '%';
        }

        updatePositionChip();
        refreshMicReadout();
        refreshMicOnsets();
    }

    /* 起音次数：跟谱引擎每匹配上一次就闪一下，方便确认麦克风确实听到了琴声。 */
    function refreshMicOnsets() {
        var tag = $('mic-onset');
        if (!tag) return;
        var pulse = state.follow.onsetPulse || 0;
        tag.textContent = String(pulse);
        if (pulse !== lastOnsetPulse) {
            lastOnsetPulse = pulse;
            tag.dataset.pulse = 'true';
            setTimeout(function () { tag.dataset.pulse = 'false'; }, 110);
        }
    }

    async function startFollowing() {
        if (state.follow.active) return;
        if (state.activeKind !== 'notation' || !state.viewer.structure) {
            toast('先打开一份 MIDI / MusicXML 乐谱再跟谱', 'warning');
            return;
        }
        if (state.player.playing) postViewer('pause');

        setLoading('正在打开麦克风…');
        var started = await listening.start();
        if (!started) {
            clearLoading();
            return;
        }
        clearLoading();

        listening.startFollowing(state.viewer.structure, tempoOf(state.viewer.structure), 0);
        state.follow.active = true;
        state.follow.cursorTick = 0;
        state.follow.measure = 0;
        state.follow.confidence = 0;
        state.follow.onsetPulse = 0;
        peakLevelDb = MIN_LEVEL_DB;
        lastOnsetPulse = 0;
        state.pageTurner.reset();
        refreshMicPanel();
        updateMicTab();
        toast('跟谱已开始，弹奏钢琴即可自动定位');
    }

    function stopFollowing(silent) {
        if (!state.follow.active) return;
        state.follow.active = false;
        state.follow.confidence = 0;
        listening.stopAnalysis();
        postViewer('hideCursor');
        refreshMicPanel();
        updateMicTab();
        if (!silent) toast('已停止跟谱');
    }

    function updateMicTab() {
        var dot = $('mic-tab-dot');
        if (dot) dot.dataset.live = (state.follow.active || state.tuner.running) ? 'true' : 'false';
    }

    /* ================================================================== */
    /* 电平表 / 音级读数                                                    */
    /* ================================================================== */

    var meterDirty = false;
    var lastFrame = null;
    var peakLevelDb = MIN_LEVEL_DB;
    var lastOnsetPulse = 0;

    function updateMeter(frame) {
        lastFrame = frame;
        if (meterDirty) return;
        meterDirty = true;
        global.requestAnimationFrame(function () {
            meterDirty = false;
            if (lastFrame) paintMeter(lastFrame);
        });
    }

    function paintMeter(frame) {
        var level = typeof frame.levelDb === 'number' ? frame.levelDb : MIN_LEVEL_DB;
        var noise = typeof frame.noiseFloorDb === 'number' ? frame.noiseFloorDb : MIN_LEVEL_DB;
        var fraction = clamp((level - MIN_LEVEL_DB) / (0 - MIN_LEVEL_DB), 0, 1);

        var fill = $('mic-level-fill');
        var noiseMark = $('mic-noise');
        var readout = $('mic-level-db');
        if (fill) fill.style.width = (fraction * 100).toFixed(1) + '%';
        if (noiseMark) {
            var noiseFraction = clamp((noise - MIN_LEVEL_DB) / (0 - MIN_LEVEL_DB), 0, 1);
            noiseMark.style.left = (noiseFraction * 100).toFixed(1) + '%';
        }
        if (readout) readout.textContent = (level <= MIN_LEVEL_DB ? '静音' : Math.round(level) + ' dB');

        if (level > peakLevelDb) {
            peakLevelDb = level;
            var peakTag = $('mic-peak-db');
            if (peakTag) peakTag.textContent = Math.round(peakLevelDb) + ' dB';
        }
    }

    function refreshMicReadout() {
        var container = $('mic-pitch-classes');
        if (!container) return;

        var chroma = (lastFrame && lastFrame.chroma) ? lastFrame.chroma : null;
        var top = state.follow.topPitchClasses || [];
        var targets = state.follow.targetPitchClasses || [];
        var peak = 0;
        if (chroma) {
            for (var i = 0; i < chroma.length; i++) if (chroma[i] > peak) peak = chroma[i];
        }

        for (var c = 0; c < 12; c++) {
            var cell = container.children[c];
            if (!cell) continue;
            var level = 0;
            if (chroma && peak > 0) {
                var ratio = chroma[c] / peak;
                if (ratio > 0.66) level = 3;
                else if (ratio > 0.33) level = 2;
                else if (ratio > 0.12) level = 1;
            }
            cell.dataset.level = String(level);
            var isTarget = targets.indexOf(c) >= 0;
            cell.dataset.target = isTarget ? 'true' : 'false';
            var isTop = top.indexOf(c) >= 0;
            cell.style.opacity = (level === 0 && !isTarget) ? '0.55' : '1';
        }
    }

    /* ================================================================== */
    /* 跟谱面板                                                            */
    /* ================================================================== */

    function buildMicPanel() {
        var body = $('mic-panel-body');
        body.innerHTML =
            '<section>' +
                '<div class="panel-section__label"><span>输入电平</span><span id="mic-sr">—</span></div>' +
                '<div class="meter">' +
                    '<div class="meter__row"><span>当前</span><strong id="mic-level-db">静音</strong></div>' +
                    '<div class="meter__track">' +
                        '<div class="meter__fill" id="mic-level-fill"></div>' +
                        '<div class="meter__noise" id="mic-noise"></div>' +
                    '</div>' +
                    '<div class="meter__row"><span>峰值</span><strong id="mic-peak-db">—</strong></div>' +
                    '<div class="meter__row"><span>起音次数</span><strong id="mic-onset" data-pulse="false">0</strong></div>' +
                '</div>' +
            '</section>' +
            '<section>' +
                '<div class="panel-section__label"><span>识别到的音级</span><span>目标画线</span></div>' +
                '<div class="pitch-classes" id="mic-pitch-classes">' +
                    NOTE_LABELS.map(function (label) {
                        return '<div class="pitch-class" data-level="0" data-target="false">' + label + '</div>';
                    }).join('') +
                '</div>' +
                '<p class="panel-note">下划线标出的是当前乐谱位置期望弹出的音级，高亮越亮说明这个音在当前和弦里越突出。</p>' +
            '</section>' +
            '<section>' +
                '<div class="panel-section__label"><span>跟谱状态</span><span id="mic-confidence">0%</span></div>' +
                '<div class="status-line" id="mic-status">尚未开始</div>' +
            '</section>' +
            '<button class="filled-btn" id="btn-follow" type="button" style="width:100%;justify-content:center;">' +
                icon('i-mic') + '<span id="btn-follow-text">开始跟谱</span>' +
            '</button>';

        $('btn-follow').addEventListener('click', function () {
            if (state.follow.active) stopFollowing();
            else startFollowing();
        });
        refreshMicPanel();
    }

    function refreshMicPanel() {
        var button = $('btn-follow');
        var status = $('mic-status');
        var confidence = $('mic-confidence');
        if (!button || !status) return;

        var canFollow = state.activeKind === 'notation' && !!state.viewer.structure;
        if (state.follow.active) {
            button.innerHTML = icon('i-mic-off') + '<span id="btn-follow-text">停止跟谱</span>';
            button.disabled = false;
            status.dataset.tone = 'ok';
            status.textContent = '正在听你弹奏 · 第 ' + (state.follow.measure + 1) + ' 小节';
        } else {
            button.innerHTML = icon('i-mic') + '<span id="btn-follow-text">开始跟谱</span>';
            button.disabled = !canFollow;
            status.dataset.tone = '';
            status.textContent = canFollow
                ? '点一下开始，然后用麦克风听钢琴'
                : '打开一份 MIDI / MusicXML 乐谱后才能跟谱';
        }
        if (confidence) {
            confidence.textContent = Math.round(clamp(state.follow.confidence, 0, 1) * 100) + '%';
        }
        updateMicTab();
    }

    function openMicPanel(open) {
        var panel = $('mic-panel');
        var tab = $('mic-tab');
        panel.dataset.open = open ? 'true' : 'false';
        panel.setAttribute('aria-hidden', open ? 'false' : 'true');
        tab.dataset.open = open ? 'true' : 'false';
        tab.setAttribute('aria-label', open ? '收起跟谱面板' : '展开跟谱面板');
    }

    /* ================================================================== */
    /* 滚动谱                                                              */
    /* ================================================================== */

    function releasePageUrls() {
        state.pageUrls.forEach(function (url) {
            try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
        });
        state.pageUrls = [];
    }

    function renderScrollPages(entry) {
        var container = $('scroll-pages');
        container.innerHTML = '';
        releasePageUrls();

        return Promise.all((entry.pages || []).map(function (page, index) {
            var url = URL.createObjectURL(page.blob);
            state.pageUrls.push(url);

            var wrapper = doc.createElement('div');
            wrapper.className = 'score-page';
            wrapper.innerHTML = '<span class="score-page__index">' + (index + 1) + '</span>' +
                '<img alt="第 ' + (index + 1) + ' 页" src="' + url + '">';
            container.appendChild(wrapper);

            var image = wrapper.querySelector('img');
            return new Promise(function (resolve) {
                if (image.complete) { resolve(); return; }
                image.addEventListener('load', resolve, { once: true });
                image.addEventListener('error', resolve, { once: true });
            });
        }));
    }

    function openScroll(entry) {
        if (!entry) return;
        state.scrollEntry = entry;
        state.activeKind = 'scroll';

        var duration = entry.durationSeconds > 0 ? entry.durationSeconds : settings.scrollDurationSeconds;
        state.scrollPlay.duration = duration;
        state.scrollPlay.elapsed = 0;
        state.scrollPlay.playing = false;

        setTitle(entry.name, (entry.pages || []).length + ' 页 · 总时长 ' + formatDuration(duration));
        showEmptyState(false);
        setLoading('正在准备谱页…');

        renderScrollPages(entry).then(function () {
            clearLoading();
            var viewport = $('scroll-viewport');
            var ratio = clamp(entry.scrollRatio || 0, 0, 1);
            state.scrollPlay.elapsed = ratio * duration;
            state.scrollPlay.programmatic = true;
            applyScrollRatio(ratio, false);
            setActiveKind('scroll');
            updateScrollReadout();
            setTimeout(function () { state.scrollPlay.programmatic = false; }, 60);
        });

        PianoLibrary.rememberLastOpened('scroll', entry.id);
    }

    function applyScrollRatio(ratio, smooth) {
        var viewport = $('scroll-viewport');
        var max = viewport.scrollHeight - viewport.clientHeight;
        if (max <= 0) return;
        var top = clamp(ratio, 0, 1) * max;
        if (smooth) viewport.scrollTo({ top: top, behavior: 'smooth' });
        else viewport.scrollTop = top;
    }

    function currentScrollRatio() {
        var viewport = $('scroll-viewport');
        var max = viewport.scrollHeight - viewport.clientHeight;
        if (max <= 0) return 0;
        return clamp(viewport.scrollTop / max, 0, 1);
    }

    function updateScrollReadout() {
        var time = $('scroll-time');
        var seek = $('scroll-seek');
        var pageTag = $('scroll-page');
        var ratio = state.scrollPlay.duration > 0
            ? clamp(state.scrollPlay.elapsed / state.scrollPlay.duration, 0, 1) : 0;

        if (time) {
            time.textContent = formatDuration(state.scrollPlay.elapsed) + ' / ' +
                formatDuration(state.scrollPlay.duration);
        }
        if (seek && doc.activeElement !== seek) {
            seek.value = String(Math.round(ratio * 1000));
        }
        if (pageTag) {
            var pages = state.scrollEntry ? (state.scrollEntry.pages || []).length : 0;
            var percent = Math.round(ratio * 100) + '%';
            if (pages > 1) {
                var index = clamp(Math.floor(ratio * pages), 0, pages - 1);
                pageTag.textContent = '第 ' + (index + 1) + '/' + pages + ' 页 · ' + percent;
            } else {
                pageTag.textContent = percent;
            }
        }
    }

    function scrollLoop(timestamp) {
        if (!state.scrollPlay.playing) return;
        if (!state.scrollPlay.lastTs) state.scrollPlay.lastTs = timestamp;
        var delta = (timestamp - state.scrollPlay.lastTs) / 1000;
        state.scrollPlay.lastTs = timestamp;
        state.scrollPlay.elapsed += delta;

        if (state.scrollPlay.elapsed >= state.scrollPlay.duration) {
            state.scrollPlay.elapsed = state.scrollPlay.duration;
            applyScrollRatio(1, false);
            updateScrollReadout();
            toggleScrollPlayback(false);
            persistScrollPosition();
            return;
        }

        state.scrollPlay.programmatic = true;
        applyScrollRatio(state.scrollPlay.elapsed / state.scrollPlay.duration, false);
        updateScrollReadout();
        global.requestAnimationFrame(function () {
            state.scrollPlay.programmatic = false;
        });
        global.requestAnimationFrame(scrollLoop);
    }

    function toggleScrollPlayback(force) {
        var next = typeof force === 'boolean' ? force : !state.scrollPlay.playing;
        state.scrollPlay.playing = next;
        state.scrollPlay.lastTs = 0;
        updatePlayButton();
        if (next) {
            if (state.scrollPlay.elapsed >= state.scrollPlay.duration) {
                state.scrollPlay.elapsed = 0;
                applyScrollRatio(0, false);
            }
            global.requestAnimationFrame(scrollLoop);
        }
    }

    var persistTimer = null;
    function persistScrollPosition() {
        if (!state.scrollEntry) return;
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = setTimeout(function () {
            if (!state.scrollEntry) return;
            var ratio = currentScrollRatio();
            state.scrollEntry.scrollRatio = ratio;
            state.scrollEntry.durationSeconds = state.scrollPlay.duration;
            PianoLibrary.updateScroll(state.scrollEntry.id, {
                scrollRatio: ratio,
                durationSeconds: state.scrollPlay.duration
            });
        }, 700);
    }

    /* ================================================================== */
    /* 校音                                                                */
    /* ================================================================== */

    async function startTuner() {
        if (state.follow.active) stopFollowing(true);
        setLoading('正在打开麦克风…');
        var started = await listening.start();
        clearLoading();
        if (!started) return;
        listening.startCalibration();
        state.tuner.running = true;
        state.tuner.state = null;
        $('btn-tuner-toggle').innerHTML = icon('i-mic-off') + '停止监听';
        $('tuner-message').dataset.tone = '';
        $('tuner-message').textContent = '请弹奏中央 C（键盘正中间的那个 C）';
        resetTunerRing();
        peakLevelDb = MIN_LEVEL_DB;
        updateMicTab();
    }

    function stopTuner() {
        state.tuner.running = false;
        listening.stopAnalysis();
        if (!state.follow.active) listening.stop();
        var button = $('btn-tuner-toggle');
        if (button) button.innerHTML = icon('i-mic') + '开始监听';
        resetTunerRing();
        var progress = $('tuner-progress');
        if (progress) progress.hidden = true;
        updateMicTab();
    }

    function applyCalibration(calibration) {
        state.tuner.state = calibration;
        state.tuner.hasCalibration = calibration.hasCalibration;
        state.tuner.offsetCents = calibration.offsetCents;

        var noteEl = $('tuner-note');
        var octaveEl = $('tuner-octave');
        var hzEl = $('tuner-hz');
        var centsEl = $('tuner-cents');
        var needle = $('tuner-needle');
        var gauge = $('tuner-gauge');
        var messageEl = $('tuner-message');

        var inTune = Math.abs(calibration.centsDeviation) <= 5 && calibration.isSounding;

        if (calibration.isSounding && calibration.noteName) {
            noteEl.textContent = calibration.noteName.replace(/-?\d+$/, '');
            octaveEl.textContent = calibration.octave;
            hzEl.textContent = calibration.frequencyHz.toFixed(1) + ' Hz';
            centsEl.textContent = (calibration.centsDeviation >= 0 ? '+' : '') +
                calibration.centsDeviation.toFixed(1) + ' 音分';
        } else {
            noteEl.textContent = '--';
            octaveEl.textContent = '';
            hzEl.textContent = state.tuner.running ? '等待弹奏…' : '等待开始监听';
            centsEl.textContent = '0 音分';
        }

        centsEl.dataset.inTune = inTune ? 'true' : 'false';
        gauge.dataset.inTune = inTune ? 'true' : 'false';
        if (needle) {
            var cents = calibration.isSounding ? clamp(calibration.centsDeviation, -50, 50) : 0;
            needle.style.left = (50 + cents) + '%';
        }

        /* 音高环：高亮当前识别到的音级，跟手机端 CalibrationScreen 一致。 */
        var ring = $('tuner-ring');
        if (ring) {
            for (var i = 0; i < ring.children.length; i++) {
                ring.children[i].dataset.active =
                    (calibration.isSounding && calibration.pitchClass === i) ? 'true' : 'false';
            }
        }

        /* 中央 C 参考采样进度：只在还没学会偏移时出现。 */
        var progress = $('tuner-progress');
        if (progress) {
            var awaiting = calibration.phase === 'AwaitingReference';
            progress.hidden = !awaiting;
            if (awaiting) {
                var collected = calibration.collected || 0;
                var total = calibration.referenceSamples || 8;
                $('tuner-progress-text').textContent = collected + ' / ' + total;
                $('tuner-progress-fill').style.width =
                    Math.round(clamp(collected / total, 0, 1) * 100) + '%';
            }
        }

        if (calibration.message) {
            messageEl.textContent = calibration.message;
            messageEl.dataset.tone = calibration.hasCalibration ? 'ok' : 'warning';
        } else if (inTune) {
            messageEl.textContent = '准！保持在 ±5 音分以内';
            messageEl.dataset.tone = 'ok';
        } else if (calibration.isSounding) {
            messageEl.textContent = '继续弹这个音，让读数稳定下来';
            messageEl.dataset.tone = '';
        }

        renderTunerStats();
    }

    function renderTunerStats() {
        var container = $('tuner-stats');
        if (!container) return;
        var offset = state.tuner.offsetCents || 0;
        var rows = [
            ['校准状态', state.tuner.hasCalibration ? '已校准' : '未校准'],
            ['音高偏移', (offset >= 0 ? '+' : '') + Math.round(offset) + ' 音分'],
            ['采样率', listening.sampleRate ? (listening.sampleRate / 1000).toFixed(1) + ' kHz' : '—'],
            ['识别范围', 'A0 – C8（88 键）']
        ];
        container.innerHTML = rows.map(function (row) {
            return '<div class="kv"><span class="kv__k">' + escapeHtml(row[0]) +
                '</span><span class="kv__v">' + escapeHtml(row[1]) + '</span></div>';
        }).join('');
    }

    function refreshTunerRow() {
        var status = $('tuner-row-status');
        if (!status) return;
        var offset = state.tuner.offsetCents || 0;
        status.textContent = state.tuner.hasCalibration
            ? '已校准 · ' + (offset >= 0 ? '+' : '') + Math.round(offset) + ' 音分'
            : '未校准';
    }

    /* 音高环：十二个音级一格，用来直观看出当前弹的是哪个音。 */
    function buildTunerRing() {
        var ring = $('tuner-ring');
        if (!ring) return;
        ring.innerHTML = NOTE_LABELS.map(function (label) {
            return '<div class="pitch-class" data-active="false">' + label + '</div>';
        }).join('');
    }

    function resetTunerRing() {
        var ring = $('tuner-ring');
        if (!ring) return;
        for (var i = 0; i < ring.children.length; i++) ring.children[i].dataset.active = 'false';
    }

    /* ================================================================== */
    /* 底部控制条                                                          */
    /* ================================================================== */

    function buildBar() {
        var bar = $('bottombar');
        if (!hasScore()) {
            bar.innerHTML = '';
            return;
        }

        if (state.activeKind === 'scroll') {
            bar.innerHTML =
                '<button class="icon-btn" id="btn-restart" type="button" title="回到开头" aria-label="回到开头">' + icon('i-restart') + '</button>' +
                '<button class="play-btn" id="btn-play" type="button" aria-label="播放">' + icon('i-play') + '</button>' +
                '<button class="icon-btn" id="btn-stop" type="button" title="停止" aria-label="停止">' + icon('i-stop') + '</button>' +
                '<button class="icon-btn" id="btn-duration" type="button" title="设置总时长" aria-label="设置总时长">' + icon('i-timer') + '</button>' +
                '<div class="progress-rail">' +
                    '<span class="progress-rail__time" id="scroll-time">00:00 / 03:00</span>' +
                    '<input type="range" id="scroll-seek" min="0" max="1000" value="0" aria-label="滚动进度">' +
                    '<span class="progress-rail__page" id="scroll-page">—</span>' +
                '</div>';
            bindScrollBar();
        } else {
            bar.innerHTML =
                '<button class="icon-btn" id="btn-restart" type="button" title="回到开头" aria-label="回到开头">' + icon('i-restart') + '</button>' +
                '<button class="icon-btn" id="btn-prev-page" type="button" title="上一页" aria-label="上一页">' + icon('i-chevron-left') + '</button>' +
                '<button class="play-btn" id="btn-play" type="button" aria-label="播放">' + icon('i-play') + '</button>' +
                '<button class="icon-btn" id="btn-next-page" type="button" title="下一页" aria-label="下一页">' + icon('i-chevron-right') + '</button>' +
                '<button class="icon-btn" id="btn-stop" type="button" title="停止" aria-label="停止">' + icon('i-stop') + '</button>' +
                '<div class="bar__label">' +
                    '<span class="bar__label-main" id="bar-main">准备中…</span>' +
                    '<span class="bar__label-sub" id="bar-sub">—</span>' +
                '</div>' +
                '<div class="bar__spacer"></div>' +
                '<div class="bar__confidence" id="bar-confidence" data-low="true"><span></span></div>' +
                '<button class="toggle-chip" id="btn-autoturn" type="button" data-on="' + (state.autoPageTurn ? 'true' : 'false') + '">' +
                    icon('i-swap') + '<span>自动翻页</span></button>';
            bindNotationBar();
        }
        updatePlayButton();
        updatePageButtons();
    }

    function bindNotationBar() {
        $('btn-play').addEventListener('click', togglePlayer);
        $('btn-stop').addEventListener('click', function () {
            postViewer('stop');
            state.player.playing = false;
            updatePlayButton();
        });
        $('btn-prev-page').addEventListener('click', function () {
            scrollToPage(clamp(state.displayedPage - 1, 0, Math.max(0, state.viewer.pageCount - 1)));
        });
        $('btn-next-page').addEventListener('click', function () {
            scrollToPage(clamp(state.displayedPage + 1, 0, Math.max(0, state.viewer.pageCount - 1)));
        });
        $('btn-restart').addEventListener('click', function () {
            postViewer('seekTo', [0]);
            state.follow.cursorTick = 0;
            state.follow.measure = 0;
            state.follow.confidence = 0;
            state.pageTurner.reset();
            if (state.follow.active) {
                listening.startFollowing(state.viewer.structure, tempoOf(state.viewer.structure), 0);
            }
            refreshFollowUi();
        });
        $('btn-autoturn').addEventListener('click', function () {
            state.autoPageTurn = !state.autoPageTurn;
            this.dataset.on = state.autoPageTurn ? 'true' : 'false';
            toast(state.autoPageTurn ? '自动翻页已开启' : '自动翻页已关闭');
        });
    }

    /* 上一页 / 下一页在首末页要禁用，跟手机端一致。 */
    function updatePageButtons() {
        var prev = $('btn-prev-page');
        var next = $('btn-next-page');
        if (!prev || !next) return;
        var last = Math.max(0, state.viewer.pageCount - 1);
        prev.disabled = state.displayedPage <= 0;
        next.disabled = state.viewer.pageCount <= 1 || state.displayedPage >= last;
    }

    function bindScrollBar() {
        $('btn-play').addEventListener('click', function () { toggleScrollPlayback(); });
        $('btn-stop').addEventListener('click', function () {
            toggleScrollPlayback(false);
            scrollToStart();
        });
        $('btn-restart').addEventListener('click', function () { scrollToStart(); });
        $('btn-duration').addEventListener('click', openDurationDialog);
        var seek = $('scroll-seek');
        seek.addEventListener('input', function () {
            var ratio = Number(seek.value) / 1000;
            state.scrollPlay.elapsed = ratio * state.scrollPlay.duration;
            state.scrollPlay.programmatic = true;
            applyScrollRatio(ratio, false);
            updateScrollReadout();
            state.scrollPlay.lastTs = 0;
            setTimeout(function () { state.scrollPlay.programmatic = false; }, 60);
        });
        seek.addEventListener('change', persistScrollPosition);
    }

    /* 回到第一页并把进度归零；手机端的“回到开头”与“停止”都落在这里。 */
    function scrollToStart() {
        state.scrollPlay.elapsed = 0;
        state.scrollPlay.lastTs = 0;
        state.scrollPlay.programmatic = true;
        applyScrollRatio(0, false);
        updateScrollReadout();
        setTimeout(function () { state.scrollPlay.programmatic = false; }, 60);
        persistScrollPosition();
    }

    function openDurationDialog() {
        var current = clamp(Math.round(state.scrollPlay.duration), 20, 1800);
        openDialog({
            title: '设置全曲总时长',
            subtitle: '滚动速度按这个时长均分整份谱面，之后可随时暂停或拖动调整',
            body:
                '<div class="meter">' +
                    '<div class="meter__row"><span>当前总时长</span><strong id="dur-value">' +
                        formatDuration(current) + '</strong></div>' +
                    '<input type="range" id="dur-range" min="20" max="1800" step="10" value="' +
                        current + '" aria-label="全曲总时长">' +
                '</div>' +
                '<div class="dur-presets">' +
                    [60, 120, 180, 300].map(function (preset) {
                        return '<button class="text-btn" type="button" data-preset="' + preset + '">' +
                            preset + ' 秒</button>';
                    }).join('') +
                '</div>',
            foot:
                '<button class="text-btn" id="dur-cancel" type="button">取消</button>' +
                '<button class="filled-btn" id="dur-ok" type="button">完成</button>',
            onOpen: function (root) {
                var range = root.querySelector('#dur-range');
                var value = root.querySelector('#dur-value');
                var pending = current;

                function sync(next) {
                    pending = clamp(Math.round(next), 20, 1800);
                    range.value = String(pending);
                    value.textContent = formatDuration(pending);
                }

                range.addEventListener('input', function () { sync(Number(range.value)); });
                root.querySelectorAll('[data-preset]').forEach(function (button) {
                    button.addEventListener('click', function () { sync(Number(button.dataset.preset)); });
                });
                root.querySelector('#dur-cancel').addEventListener('click', closeDialog);
                root.querySelector('#dur-ok').addEventListener('click', function () {
                    applyScrollDuration(pending);
                    closeDialog();
                });
            }
        });
    }

    /* 改总时长时保持当前进度比例，免得用户正在看的地方被跳走。 */
    function applyScrollDuration(seconds) {
        var previous = state.scrollPlay.duration;
        var ratio = previous > 0 ? clamp(state.scrollPlay.elapsed / previous, 0, 1) : 0;
        state.scrollPlay.duration = seconds;
        state.scrollPlay.elapsed = ratio * seconds;

        if (state.scrollEntry) {
            state.scrollEntry.durationSeconds = seconds;
            state.scrollEntry.scrollRatio = ratio;
            PianoLibrary.updateScroll(state.scrollEntry.id, {
                durationSeconds: seconds,
                scrollRatio: ratio
            });
            setTitle(state.scrollEntry.name, (state.scrollEntry.pages || []).length +
                ' 页 · 总时长 ' + formatDuration(seconds));
        }
        updateScrollReadout();
    }

    /* ================================================================== */
    /* 弹窗                                                                */
    /* ================================================================== */

    var scrim = $('dialog-scrim');

    function openDialog(options) {
        scrim.innerHTML =
            '<div class="dialog" role="dialog" aria-modal="true" aria-label="' + escapeHtml(options.title) + '">' +
                '<div class="dialog__head">' +
                    '<h2>' + escapeHtml(options.title) + '</h2>' +
                    (options.subtitle ? '<p>' + escapeHtml(options.subtitle) + '</p>' : '') +
                '</div>' +
                '<div class="dialog__body">' + (options.body || '') + '</div>' +
                '<div class="dialog__foot">' + (options.foot || '') + '</div>' +
            '</div>';
        scrim.hidden = false;
        global.requestAnimationFrame(function () { scrim.dataset.open = 'true'; });
        if (options.onOpen) options.onOpen(scrim);
    }

    function closeDialog() {
        scrim.dataset.open = 'false';
        setTimeout(function () {
            scrim.hidden = true;
            scrim.innerHTML = '';
        }, 190);
    }

    scrim.addEventListener('click', function (event) {
        if (event.target === scrim) closeDialog();
    });

    doc.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && scrim.dataset.open === 'true') closeDialog();
    });

    /* ---------- 导入 ---------- */

    function openImportDialog() {
        openDialog({
            title: '导入乐谱',
            subtitle: '记谱乐谱会排版成五线谱并可跟谱；PDF 与照片进滚动谱，按总时长匀速滚动',
            body:
                '<button class="import-option" id="opt-notation" type="button">' +
                    '<span class="import-option__icon">' + icon('i-music') + '</span>' +
                    '<span class="import-option__text"><strong>记谱乐谱</strong>' +
                    '<span>MIDI · MusicXML · MXL，自动翻译成五线谱</span></span>' +
                '</button>' +
                '<button class="import-option" id="opt-scroll" type="button">' +
                    '<span class="import-option__icon">' + icon('i-photo') + '</span>' +
                    '<span class="import-option__text"><strong>滚动谱</strong>' +
                    '<span>PDF · 相册照片，可多选，逐页滚动</span></span>' +
                '</button>',
            foot: '<button class="text-btn" id="dialog-cancel" type="button">取消</button>',
            onOpen: function (root) {
                root.querySelector('#opt-notation').addEventListener('click', function () {
                    closeDialog();
                    $('file-notation').click();
                });
                root.querySelector('#opt-scroll').addEventListener('click', function () {
                    closeDialog();
                    $('file-scroll').click();
                });
                root.querySelector('#dialog-cancel').addEventListener('click', closeDialog);
            }
        });
    }

    function ensureFileInputs() {
        if ($('file-notation')) return;

        var notation = doc.createElement('input');
        notation.type = 'file';
        notation.id = 'file-notation';
        notation.accept = '.mid,.midi,.musicxml,.xml,.mxl';
        notation.hidden = true;
        notation.addEventListener('change', function () {
            var file = notation.files && notation.files[0];
            notation.value = '';
            if (file) importNotationFile(file);
        });
        doc.body.appendChild(notation);

        var scroll = doc.createElement('input');
        scroll.type = 'file';
        scroll.id = 'file-scroll';
        scroll.accept = '.pdf,image/*';
        scroll.multiple = true;
        scroll.hidden = true;
        scroll.addEventListener('change', function () {
            var files = scroll.files ? Array.prototype.slice.call(scroll.files) : [];
            scroll.value = '';
            if (files.length) importScrollFiles(files);
        });
        doc.body.appendChild(scroll);
    }

    function buildNotationRecord(name, bytes) {
        var format = PianoMidi.detectFormat(bytes, name);
        if (format === PianoMidi.ScoreFormat.UNKNOWN) {
            throw new Error('无法识别「' + name + '」的格式，请提供 MIDI、MusicXML 或 MXL 文件');
        }
        var prepared;
        try {
            prepared = PianoMidi.prepare(name, format, bytes);
        } catch (error) {
            if (error && error.name === 'MidiConversionException') {
                throw new Error('MIDI 解析失败：' + error.message);
            }
            throw error;
        }
        var blob = new Blob([prepared.bytes], {
            type: prepared.renderFormat === PianoMidi.ScoreFormat.MUSIC_XML
                ? 'application/vnd.recordare.musicxml+xml'
                : 'application/octet-stream'
        });
        return {
            name: PianoImport.stripExtension(name),
            sourceFormat: prepared.sourceFormat,
            renderFormat: prepared.renderFormat,
            size: blob.size,
            blob: blob
        };
    }

    function importNotationFile(file) {
        setLoading('正在解析 ' + file.name + '…');
        file.arrayBuffer().then(function (buffer) {
            var record = buildNotationRecord(file.name, new Uint8Array(buffer));
            return PianoLibrary.putNotation(record);
        }).then(function (entry) {
            clearLoading();
            openNotation(entry);
            toast('已导入「' + entry.name + '」');
        }).catch(function (error) {
            clearLoading();
            toast(error && error.message ? error.message : '导入失败', 'error');
        });
    }

    function importScrollFiles(files) {
        setLoading('正在准备谱页…');
        PianoImport.importScrollFiles(files, function (message) {
            setLoading(message);
        }).then(function (result) {
            return PianoLibrary.putScroll({
                name: result.name,
                pages: result.pages,
                durationSeconds: settings.scrollDurationSeconds,
                scrollRatio: 0
            });
        }).then(function (entry) {
            clearLoading();
            openScroll(entry);
            toast('已导入「' + entry.name + '」共 ' + entry.pages.length + ' 页');
        }).catch(function (error) {
            clearLoading();
            toast(error && error.message ? error.message : '导入失败', 'error');
        });
    }

    /* ---------- 乐谱库 ---------- */

    function openLibraryDialog() {
        Promise.all([PianoLibrary.listNotation(), PianoLibrary.listScroll()]).then(function (result) {
            var notation = result[0];
            var scroll = result[1];
            var items = [];

            notation.forEach(function (entry) {
                items.push({
                    kind: 'notation',
                    id: entry.id,
                    name: entry.name,
                    meta: PianoMidi.formatLabel(entry.sourceFormat) + ' · ' + formatBytes(entry.size),
                    icon: 'i-music'
                });
            });
            scroll.forEach(function (entry) {
                items.push({
                    kind: 'scroll',
                    id: entry.id,
                    name: entry.name,
                    meta: (entry.pages || []).length + ' 页 · ' +
                        formatDuration(entry.durationSeconds || settings.scrollDurationSeconds),
                    icon: 'i-photo'
                });
            });

            var body = items.length
                ? '<div class="library-grid">' + items.map(function (item) {
                    var active = (item.kind === 'notation' && state.notation && state.notation.id === item.id) ||
                        (item.kind === 'scroll' && state.scrollEntry && state.scrollEntry.id === item.id);
                    return '<div class="library-item" role="button" tabindex="0" data-id="' + item.id +
                        '" data-kind="' + item.kind + '"' + (active ? ' data-active="true"' : '') + '>' +
                        '<span class="library-item__icon">' + icon(item.icon) + '</span>' +
                        '<span class="library-item__name">' + escapeHtml(item.name) + '</span>' +
                        '<span class="library-item__meta">' + escapeHtml(item.meta) + '</span>' +
                        '<button class="library-item__delete" type="button" data-delete="' + item.id +
                        '" data-kind="' + item.kind + '" aria-label="删除">' + icon('i-delete') + '</button>' +
                        '</div>';
                }).join('') + '</div>'
                : '<p class="panel-note">乐谱库还是空的。点下面的「导入乐谱」，或先打开一份内置示例。</p>';

            openDialog({
                title: '乐谱库',
                subtitle: '所有导入的乐谱都存在本机，关掉页面也不会丢',
                body: body,
                foot:
                    '<button class="text-btn" id="library-samples" type="button">' + icon('i-book') + '示例</button>' +
                    '<div class="bar__spacer"></div>' +
                    '<button class="text-btn" id="library-import" type="button">' + icon('i-import') + '导入</button>' +
                    '<button class="text-btn" id="library-close" type="button">关闭</button>',
                onOpen: function (root) {
                    root.querySelector('#library-close').addEventListener('click', closeDialog);
                    root.querySelector('#library-import').addEventListener('click', function () {
                        closeDialog();
                        openImportDialog();
                    });
                    root.querySelector('#library-samples').addEventListener('click', function () {
                        closeDialog();
                        openSamplesDialog();
                    });

                    root.querySelectorAll('.library-item').forEach(function (node) {
                        node.addEventListener('click', function (event) {
                            if (event.target.closest('[data-delete]')) return;
                            closeDialog();
                            openLibraryEntry(node.dataset.kind, node.dataset.id);
                        });
                        node.addEventListener('keydown', function (event) {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                closeDialog();
                                openLibraryEntry(node.dataset.kind, node.dataset.id);
                            }
                        });
                    });

                    root.querySelectorAll('[data-delete]').forEach(function (button) {
                        button.addEventListener('click', function (event) {
                            event.stopPropagation();
                            removeLibraryEntry(button.dataset.kind, button.dataset.delete);
                        });
                    });
                }
            });
        });
    }

    function openLibraryEntry(kind, id) {
        if (kind === 'notation') {
            PianoLibrary.getNotation(id).then(function (entry) {
                if (entry) openNotation(entry);
            });
        } else {
            PianoLibrary.getScroll(id).then(function (entry) {
                if (entry) openScroll(entry);
            });
        }
    }

    function removeLibraryEntry(kind, id) {
        var removal = kind === 'notation'
            ? PianoLibrary.deleteNotation(id)
            : PianoLibrary.deleteScroll(id);
        removal.then(function () {
            if (kind === 'notation' && state.notation && state.notation.id === id) {
                releaseNotationUrl();
                state.notation = null;
            }
            if (kind === 'scroll' && state.scrollEntry && state.scrollEntry.id === id) {
                releasePageUrls();
                state.scrollEntry = null;
            }
            if (!hasScore()) {
                showEmptyState(true);
                $('notation-stage').hidden = true;
                $('scroll-viewport').hidden = true;
                $('bar-layer').hidden = true;
                setTitle('智能曲谱', '导入 MIDI / MusicXML / PDF / 照片开始');
            }
            toast('已删除');
            refreshSettingsScreen();
            openLibraryDialog();
        });
    }

    /* ---------- 内置示例 ---------- */

    var SAMPLES = [
        { path: 'the_truth_that_you_leave.mid', title: 'The Truth That You Leave（你离开的事实）', subtitle: 'Pianoboy 高至豪 · 双手完整曲目' },
        { path: 'c_major_study.musicxml', title: 'C 大调练习曲（32 小节）', subtitle: 'MusicXML · 多页排版与自动翻页测试' },
        { path: 'c_major_scale.mid', title: 'C 大调音阶', subtitle: '单声部 · 基础跟谱测试' },
        { path: 'minuet_in_c.mid', title: 'C 大调小步舞曲', subtitle: '双手声部 · 分页测试' },
        { path: 'chords_study.mid', title: '和弦练习', subtitle: '密集和弦 · 复音识别测试' },
        { path: 'twinkle_piano.musicxml', title: '小星星（MusicXML）', subtitle: 'MusicXML 原生导入 · 双手谱表' }
    ];

    function openSamplesDialog() {
        openDialog({
            title: '内置示例',
            subtitle: '不用准备文件，直接点开就能试排版、跟谱与自动翻页',
            body: '<div class="library-grid">' + SAMPLES.map(function (sample, index) {
                return '<div class="library-item" role="button" tabindex="0" data-sample="' + index + '">' +
                    '<span class="library-item__icon">' + icon('i-music') + '</span>' +
                    '<span class="library-item__name">' + escapeHtml(sample.title) + '</span>' +
                    '<span class="library-item__meta">' + escapeHtml(sample.subtitle) + '</span>' +
                    '</div>';
            }).join('') + '</div>',
            foot: '<button class="text-btn" id="samples-close" type="button">关闭</button>',
            onOpen: function (root) {
                root.querySelector('#samples-close').addEventListener('click', closeDialog);
                root.querySelectorAll('[data-sample]').forEach(function (node) {
                    node.addEventListener('click', function () {
                        closeDialog();
                        loadSample(SAMPLES[Number(node.dataset.sample)]);
                    });
                });
            }
        });
    }

    function loadSample(sample) {
        setLoading('正在载入示例…');
        fetch('assets/samples/' + sample.path, { cache: 'force-cache' })
            .then(function (response) {
                if (!response.ok) throw new Error('示例文件读取失败');
                return response.arrayBuffer();
            })
            .then(function (buffer) {
                var record = buildNotationRecord(sample.path, new Uint8Array(buffer));
                record.name = sample.title;
                return PianoLibrary.putNotation(record);
            })
            .then(function (entry) {
                clearLoading();
                openNotation(entry);
            })
            .catch(function (error) {
                clearLoading();
                toast(error && error.message ? error.message : '示例载入失败', 'error');
            });
    }

    /* ---------- 更多操作 ---------- */

    /*
     * 窄屏（手机竖屏）放不下“自动翻页 / 回到开头”，跟手机端一样把它们挪到这里，
     * 保证紧凑布局下功能不丢。
     */
    function openMoreMenu() {
        var hasOpen = hasScore();
        var notation = state.activeKind === 'notation' && !!state.viewer.structure;

        openDialog({
            title: '更多操作',
            subtitle: '只影响当前打开的乐谱，乐谱库里的文件不会被删掉',
            body:
                '<button class="import-option" id="more-clear" type="button"' + (hasOpen ? '' : ' disabled') + '>' +
                    '<span class="import-option__icon">' + icon('i-delete') + '</span>' +
                    '<span class="import-option__text"><strong>清除当前乐谱</strong>' +
                    '<span>关闭当前谱面回到空态，随时可以从乐谱库重新打开</span></span>' +
                '</button>' +
                (notation
                    ? '<button class="import-option" id="more-restart" type="button">' +
                        '<span class="import-option__icon">' + icon('i-restart') + '</span>' +
                        '<span class="import-option__text"><strong>回到开头</strong>' +
                        '<span>游标与播放位置一起退回第一小节</span></span>' +
                    '</button>' +
                    '<button class="import-option" id="more-autoturn" type="button">' +
                        '<span class="import-option__icon">' + icon('i-swap') + '</span>' +
                        '<span class="import-option__text"><strong>自动翻页</strong>' +
                        '<span id="more-autoturn-state">' +
                            (state.autoPageTurn ? '已开启 · 点一下关闭' : '已关闭 · 点一下开启') +
                        '</span></span>' +
                    '</button>'
                    : ''),
            foot: '<button class="text-btn" id="more-cancel" type="button">关闭</button>',
            onOpen: function (root) {
                root.querySelector('#more-cancel').addEventListener('click', closeDialog);

                var clearButton = root.querySelector('#more-clear');
                if (clearButton) {
                    clearButton.addEventListener('click', function () {
                        clearCurrentScore();
                        closeDialog();
                    });
                }

                var restartButton = root.querySelector('#more-restart');
                if (restartButton) {
                    restartButton.addEventListener('click', function () {
                        var barRestart = $('btn-restart');
                        if (barRestart) barRestart.click();
                        closeDialog();
                        toast('已回到开头');
                    });
                }

                var autoturnButton = root.querySelector('#more-autoturn');
                if (autoturnButton) {
                    autoturnButton.addEventListener('click', function () {
                        state.autoPageTurn = !state.autoPageTurn;
                        var barToggle = $('btn-autoturn');
                        if (barToggle) barToggle.dataset.on = state.autoPageTurn ? 'true' : 'false';
                        root.querySelector('#more-autoturn-state').textContent =
                            state.autoPageTurn ? '已开启 · 点一下关闭' : '已关闭 · 点一下开启';
                        toast(state.autoPageTurn ? '自动翻页已开启' : '自动翻页已关闭');
                    });
                }
            }
        });
    }

    function clearCurrentScore() {
        if (state.follow.active) stopFollowing(true);
        if (state.scrollPlay.playing) toggleScrollPlayback(false);
        if (state.player.playing) postViewer('pause');

        releaseNotationUrl();
        releasePageUrls();
        state.notation = null;
        state.scrollEntry = null;
        state.viewer.structure = null;
        state.viewer.pageCount = 0;
        state.viewer.measureCount = 0;
        state.timeline = null;
        state.player.playing = false;
        state.player.requested = false;
        state.scrollPlay.playing = false;
        state.scrollPlay.elapsed = 0;
        state.cursorPage = 0;
        state.displayedPage = 0;
        state.expectedPageScroll = -1;
        state.pageTurner.reset();
        postViewer('hideCursor');
        PianoLibrary.clearLastOpened();

        showEmptyState(true);
        $('notation-stage').hidden = true;
        $('scroll-viewport').hidden = true;
        $('bar-layer').hidden = true;
        setTitle('智能曲谱', '导入 MIDI / MusicXML / PDF / 照片开始');
        updateTopbarButtons();
        refreshMicPanel();
        toast('已清除当前乐谱');
    }

    /* ---------- 页管理 ---------- */

    function openPageManager() {
        if (!state.scrollEntry) return;
        var entry = state.scrollEntry;

        function render() {
            var body = '<div class="page-list">' + (entry.pages || []).map(function (page, index) {
                var url = state.pageUrls[index] || '';
                return '<div class="page-row" data-index="' + index + '">' +
                    '<div class="page-row__thumb"><img alt="" src="' + url + '"></div>' +
                    '<div class="page-row__label">第 ' + (index + 1) + ' 页</div>' +
                    '<button class="icon-btn icon-btn--sm" type="button" data-move="-1"' +
                        (index === 0 ? ' disabled' : '') + ' aria-label="上移">' + icon('i-up') + '</button>' +
                    '<button class="icon-btn icon-btn--sm" type="button" data-move="1"' +
                        (index === entry.pages.length - 1 ? ' disabled' : '') + ' aria-label="下移">' + icon('i-down') + '</button>' +
                    '<button class="icon-btn icon-btn--sm" type="button" data-remove="' + index + '" aria-label="删除">' + icon('i-delete') + '</button>' +
                    '</div>';
            }).join('') + '</div>';

            var root = scrim.querySelector('.dialog__body');
            if (root) root.innerHTML = body;
            bind();
        }

        function bind() {
            var root = scrim.querySelector('.dialog__body');
            if (!root) return;
            root.querySelectorAll('.page-row').forEach(function (row) {
                var index = Number(row.dataset.index);
                row.querySelectorAll('[data-move]').forEach(function (button) {
                    button.addEventListener('click', function () {
                        var target = index + Number(button.dataset.move);
                        if (target < 0 || target >= entry.pages.length) return;
                        var moved = entry.pages.splice(index, 1)[0];
                        entry.pages.splice(target, 0, moved);
                        savePages();
                    });
                });
                var removeButton = row.querySelector('[data-remove]');
                if (removeButton) {
                    removeButton.addEventListener('click', function () {
                        if (entry.pages.length <= 1) {
                            toast('至少要保留一页', 'warning');
                            return;
                        }
                        entry.pages.splice(index, 1);
                        savePages();
                    });
                }
            });
        }

        function savePages() {
            PianoLibrary.updateScroll(entry.id, { pages: entry.pages }).then(function () {
                renderScrollPages(entry).then(function () {
                    setTitle(entry.name, entry.pages.length + ' 页 · 总时长 ' +
                        formatDuration(state.scrollPlay.duration));
                    render();
                });
            });
        }

        openDialog({
            title: '管理页面',
            subtitle: '调整顺序或删除多余页，改完立即生效',
            body: '',
            foot: '<button class="text-btn" id="pages-close" type="button">完成</button>',
            onOpen: function (root) {
                root.querySelector('#pages-close').addEventListener('click', closeDialog);
                render();
            }
        });
    }

    /* ================================================================== */
    /* 设置页                                                              */
    /* ================================================================== */

    function refreshSettingsScreen() {
        var stats = $('storage-stats');
        PianoLibrary.usage().then(function (usage) {
            var rows = [
                ['记谱乐谱', usage.notationCount + ' 份'],
                ['滚动谱', usage.scrollCount + ' 份'],
                ['谱页', usage.pageCount + ' 页'],
                ['占用空间', formatBytes(usage.bytes)]
            ];
            stats.innerHTML = rows.map(function (row) {
                return '<div class="kv"><span class="kv__k">' + escapeHtml(row[0]) +
                    '</span><span class="kv__v">' + escapeHtml(row[1]) + '</span></div>';
            }).join('');
        }).catch(function () {
            stats.innerHTML = '<div class="kv"><span class="kv__k">本地存储</span>' +
                '<span class="kv__v">不可用</span></div>';
        });

        var device = PianoPlatform.currentDevice();
        var orientation = PianoPlatform.currentOrientation();
        var deviceLabel = device === 'phone' ? '手机' : (device === 'tablet' ? '平板' : '桌面');
        var about = [
            ['应用', '智能曲谱（网页端）'],
            ['版本', 'web-1.0.0'],
            ['排版引擎', 'alphaTab'],
            ['设备识别', deviceLabel + ' · ' + (orientation === 'portrait' ? '竖屏' : '横屏')],
            ['麦克风采样率', listening.sampleRate ? (listening.sampleRate / 1000).toFixed(1) + ' kHz' : '尚未启用']
        ];
        $('about-stats').innerHTML = about.map(function (row) {
            return '<div class="kv"><span class="kv__k">' + escapeHtml(row[0]) +
                '</span><span class="kv__v">' + escapeHtml(row[1]) + '</span></div>';
        }).join('');

        var durationValue = $('scroll-duration-value');
        var durationInput = $('scroll-duration');
        if (durationValue) durationValue.textContent = settings.scrollDurationSeconds + ' 秒';
        if (durationInput && doc.activeElement !== durationInput) {
            durationInput.value = String(clamp(settings.scrollDurationSeconds, 20, 1800));
        }

        $('settings-subtitle').textContent = deviceLabel + ' · ' +
            (orientation === 'portrait' ? '竖屏' : '横屏') + ' · 外观、校音与本地存储';

        refreshTunerRow();
    }

    function bindSettings() {
        $('scroll-duration').addEventListener('input', function () {
            var seconds = Number(this.value);
            settings.setScrollDuration(seconds);
            $('scroll-duration-value').textContent = seconds + ' 秒';
        });

        $('btn-clear-storage').addEventListener('click', function () {
            openDialog({
                title: '清空全部乐谱？',
                subtitle: '本机保存的所有记谱乐谱与滚动谱都会被删除，无法恢复',
                body: '<p class="panel-note">导入的原始文件也会一并删除。设置与配色偏好不受影响。</p>',
                foot:
                    '<button class="text-btn" id="clear-cancel" type="button">取消</button>' +
                    '<button class="text-btn text-btn--danger" id="clear-confirm" type="button">' + icon('i-delete') + '清空</button>',
                onOpen: function (root) {
                    root.querySelector('#clear-cancel').addEventListener('click', closeDialog);
                    root.querySelector('#clear-confirm').addEventListener('click', function () {
                        Promise.all([PianoLibrary.listNotation(), PianoLibrary.listScroll()]).then(function (result) {
                            return Promise.all(result[0].map(function (item) {
                                return PianoLibrary.deleteNotation(item.id);
                            }).concat(result[1].map(function (item) {
                                return PianoLibrary.deleteScroll(item.id);
                            })));
                        }).then(function () {
                            releaseNotationUrl();
                            releasePageUrls();
                            PianoLibrary.clearLastOpened();
                            state.notation = null;
                            state.scrollEntry = null;
                            state.viewer.structure = null;
                            state.timeline = null;
                            showEmptyState(true);
                            $('notation-stage').hidden = true;
                            $('scroll-viewport').hidden = true;
                            $('bar-layer').hidden = true;
                            setTitle('智能曲谱', '导入 MIDI / MusicXML / PDF / 照片开始');
                            closeDialog();
                            toast('已清空本地乐谱');
                            refreshSettingsScreen();
                        });
                    });
                }
            });
        });
    }

    /* ================================================================== */
    /* 恢复上次打开 / 初始空态                                              */
    /* ================================================================== */

    function restoreLastOpened() {
        var last = PianoLibrary.lastOpened();
        if (!last) return Promise.resolve(false);

        if (last.kind === 'notation') {
            return PianoLibrary.getNotation(last.id).then(function (entry) {
                if (!entry) return false;
                openNotation(entry);
                return true;
            });
        }
        return PianoLibrary.getScroll(last.id).then(function (entry) {
            if (!entry) return false;
            openScroll(entry);
            return true;
        });
    }

    /* ================================================================== */
    /* 事件绑定                                                            */
    /* ================================================================== */

    function bindChrome() {
        $('btn-import').addEventListener('click', openImportDialog);
        $('btn-library').addEventListener('click', openLibraryDialog);
        $('btn-settings').addEventListener('click', function () { showScreen('settings'); });
        $('btn-settings-back').addEventListener('click', function () { showScreen('score'); });
        $('btn-tuner-back').addEventListener('click', function () { showScreen('settings'); });
        $('btn-empty-import').addEventListener('click', openImportDialog);
        $('btn-empty-samples').addEventListener('click', openSamplesDialog);

        $('btn-mode').addEventListener('click', function () {
            if (!(state.notation && state.scrollEntry)) return;
            setActiveKind(state.activeKind === 'notation' ? 'scroll' : 'notation');
        });
        $('btn-manage').addEventListener('click', openPageManager);
        $('btn-more').addEventListener('click', openMoreMenu);

        $('row-tuner').addEventListener('click', function () { showScreen('tuner'); });
        $('btn-tuner-toggle').addEventListener('click', function () {
            if (state.tuner.running) stopTuner();
            else startTuner();
        });
        $('btn-tuner-reset').addEventListener('click', function () {
            state.tuner.hasCalibration = false;
            state.tuner.offsetCents = 0;
            if (state.tuner.running) listening.resetCalibration();
            resetTunerRing();
            renderTunerStats();
            refreshTunerRow();
            toast('已清除校准，请重新弹奏中央 C');
        });

        $('mic-tab').addEventListener('click', function () {
            openMicPanel($('mic-panel').dataset.open !== 'true');
        });
        $('mic-panel-close').addEventListener('click', function () { openMicPanel(false); });

        /* 控制条下滑隐藏，由底部把手唤出 —— 与手机端一致。 */
        var barLayer = $('bar-layer');
        $('bar-handle').addEventListener('click', function () { barLayer.dataset.hidden = 'false'; });

        var dragStartY = null;
        $('bottombar').addEventListener('pointerdown', function (event) {
            if (event.target.closest('input,button')) dragStartY = null;
            else dragStartY = event.clientY;
        });
        $('bottombar').addEventListener('pointerup', function (event) {
            if (dragStartY == null) return;
            if (event.clientY - dragStartY > 36) barLayer.dataset.hidden = 'true';
            dragStartY = null;
        });

        /* 滚动谱：用户手动滑动时同步进度，松手后落盘。 */
        $('scroll-viewport').addEventListener('scroll', function () {
            if (state.activeKind !== 'scroll') return;
            if (state.scrollPlay.programmatic) return;
            state.scrollPlay.elapsed = currentScrollRatio() * state.scrollPlay.duration;
            updateScrollReadout();
            persistScrollPosition();
        }, { passive: true });

        /* 播放中触摸谱面即暂停，方便手动翻看 —— 与手机端一致。 */
        $('scroll-viewport').addEventListener('pointerdown', function () {
            if (state.activeKind !== 'scroll') return;
            if (!state.scrollPlay.playing) return;
            toggleScrollPlayback(false);
            toast('已暂停，可以直接拖动谱面');
        });

        /* 切到后台就停止采集并暂停，免得离开页面后麦克风还在录、音频还在响。 */
        doc.addEventListener('visibilitychange', function () {
            if (!doc.hidden) return;
            if (state.follow.active) stopFollowing(true);
            if (state.tuner.running) stopTuner();
            if (state.player.playing) postViewer('pause');
            if (state.scrollPlay.playing) toggleScrollPlayback(false);
        });

        /* 桌面端拖拽导入。 */
        ['dragover', 'drop'].forEach(function (type) {
            $('screen-score').addEventListener(type, function (event) {
                event.preventDefault();
                if (type !== 'drop') return;
                var files = event.dataTransfer && event.dataTransfer.files
                    ? Array.prototype.slice.call(event.dataTransfer.files) : [];
                if (!files.length) return;
                routeDroppedFiles(files);
            });
        });

        doc.addEventListener('keydown', function (event) {
            if (event.target && /INPUT|TEXTAREA/.test(event.target.tagName)) return;
            if (state.screen !== 'score' || scrim.dataset.open === 'true') return;

            if (event.code === 'Space') {
                event.preventDefault();
                if (state.activeKind === 'scroll') toggleScrollPlayback();
                else togglePlayer();
            } else if (event.key === 'ArrowRight' && state.activeKind === 'notation') {
                scrollToPage(clamp(state.displayedPage + 1, 0, Math.max(0, state.viewer.pageCount - 1)));
            } else if (event.key === 'ArrowLeft' && state.activeKind === 'notation') {
                scrollToPage(clamp(state.displayedPage - 1, 0, Math.max(0, state.viewer.pageCount - 1)));
            }
        });
    }

    function routeDroppedFiles(files) {
        var scrollFiles = files.filter(function (file) {
            return PianoImport.isPdf(file) || PianoImport.isImage(file);
        });
        var scoreFiles = files.filter(function (file) { return PianoImport.isScoreFile(file); });

        if (scoreFiles.length) importNotationFile(scoreFiles[0]);
        else if (scrollFiles.length) importScrollFiles(scrollFiles);
    }

    /* ================================================================== */
    /* 启动                                                                */
    /* ================================================================== */

    function boot() {
        applyTheme();
        buildThemeControls();
        bindThemeControls();
        bindChrome();
        bindSettings();
        ensureFileInputs();
        buildMicPanel();
        buildBar();
        buildTunerRing();
        renderTunerStats();

        PianoPlatform.watchEnvironment(function (env) {
            /* 设备形态或方向变了：让 viewer 按新宽度重新排版，并刷新设置页读数。 */
            if (state.notation) postViewer('relayout');
            if (state.screen === 'settings') refreshSettingsScreen();
            if (env && env.orientation) updateTopbarButtons();
        });

        showEmptyState(true);
        $('notation-stage').hidden = true;
        $('scroll-viewport').hidden = true;
        $('bar-layer').hidden = true;
        setTitle('智能曲谱', '导入 MIDI / MusicXML / PDF / 照片开始');

        restoreLastOpened().then(function (restored) {
            if (!restored) refreshSettingsScreen();
        }).catch(function () { refreshSettingsScreen(); });
    }

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
    else boot();
})(window);
