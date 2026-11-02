/*
 * PianoScoreFollower - score rendering bridge.
 *
 * Responsibilities:
 *   1. Render MIDI / MusicXML scores with alphaTab.
 *   2. Expose the rendered layout (staff systems, measures) to the native layer.
 *   3. Draw an independent cursor overlay driven by the score follower.
 *   4. Compute page breaks so the native layer can drive auto page turning.
 */
(function () {
    'use strict';

    var AT = window.alphaTab;

    var viewportEl = document.getElementById('viewport');
    var stageEl = document.getElementById('stage');
    var scoreEl = document.getElementById('score');
    var cursorLayerEl = document.getElementById('cursorLayer');
    var followAnchorTick=null, navigationAnchor=new window.FollowNavigation.Anchor();
    var notationMode = 'staff', numberedEl = document.getElementById('numbered'), numberedGraph = null;
    var hintEl = document.getElementById('hint');

    var PAGE_TOP_MARGIN = 6;

    /*
     * Where the followed staff system is parked inside the viewport, as a share of
     * its height. Sitting the active line in the upper third leaves the upcoming
     * lines visible below it, so the eye reads ahead instead of the music crawling
     * along the bottom edge.
     */
    var FOLLOW_ANCHOR_RATIO = 0.32;

    var api = null;
    var generation = 0, layoutVersion = 0, loadRequest = 0;
    var requestedPage = -1;
    var selectedStaffs = null;
    var selectedTracks = null, navigationMode = 'line', userBrowsing = false;
    var fontRequested = false;
    var systems = [];
    var pages = [];
    var systemPageIndex = [];
    var beatCursorEl = null;
    var lastMasterBarIndex = -1;
    /** Staff system the view was last anchored to, so a manual scroll is respected. */
    var lastFollowedSystem = -1;
    /** When set, the view advances one staff system at a time as the cursor moves. */
    var followCursor = true;
    var lastReportedPage = -1;
    var scrollScheduled = false;
    var hintTimer = null;
    var ready = false;
    var playerReady = false;
    var fontWanted = false;
    var fontWaitTimer = null;
    var soundFontReady = false;
    var soundFontTimer = null;
    var resizeTimer = null;
    var tapTrackingInstalled = false;
    /** Last score handed to [loadScore], so a player retry can rebuild from it. */
    var lastScoreUrl = null;

    /** Last tick the cursor was placed at, so a relayout can restore it. */
    var lastCursorTick = -1;
    var lastPlaybackReport = 0;

    /* Tap detection, so a scroll drag is not mistaken for a seek. */
    var touchSeen = false;
    var tapStartX = 0;
    var tapStartY = 0;

    /* ------------------------------------------------------------------ */
    /* Native bridge                                                       */
    /* ------------------------------------------------------------------ */

    function post(type, payload) {
        try {
            var msg = Object.assign({ type: type, generation: generation, layoutVersion: layoutVersion }, payload || {});
            if (window.AndroidHost && window.AndroidHost.postEvent) {
                window.AndroidHost.postEvent(JSON.stringify(msg));
            }
        } catch (e) {
            /* the host may be absent when the page is opened in a desktop browser */
        }
    }

    function showHint(text, durationMs) {
        if (!hintEl) return;
        hintEl.textContent = text;
        hintEl.classList.remove('hidden');
        if (hintTimer) clearTimeout(hintTimer);
        hintTimer = setTimeout(function () {
            hintEl.classList.add('hidden');
        }, durationMs || 1800);
    }

    /* ------------------------------------------------------------------ */
    /* alphaTab bootstrap                                                  */
    /* ------------------------------------------------------------------ */

    /*
     * A phone in portrait has far less usable width, so the notation is scaled down
     * to keep a sensible number of measures on every line. Landscape and tablets
     * render at full size.
     */
    function responsiveScale() {
        var width = viewportEl.clientWidth;
        if (width <= 0) return 1.0;
        if (width < 520) return 0.78;
        if (width < 720) return 0.9;
        return 1.0;
    }

    function initApi() {
        if (!AT) {
            post('error', { message: 'alphaTab 资源未加载' });
            return;
        }

        var settings = {
            core: {
                fontDirectory: '../alphatab/font/',
                useWorkers: false,
                includeNoteBounds: false,
                logLevel: 'warning'
            },
            display: {
                layoutMode: 'page',
                scale: responsiveScale(),
                stretchForce: 1.0,
                justifyLastSystem: true,
                padding: [24, 22, 28, 22],
                firstSystemPaddingTop: 6,
                resources: {
                    staffLineColor: '#2A3038',
                    barSeparatorColor: '#2A3038',
                    mainGlyphColor: '#14181D',
                    secondaryGlyphColor: '#14181D',
                    scoreInfoColor: '#14181D',
                    barNumberColor: '#535c69'
                }
            },
            player: {
                enablePlayer: true,
                /*
                 * A dedicated sampled grand/upright rather than the tiny General MIDI
                 * bank that ships with alphaTab: the GM piano is a handful of short
                 * loops and sounds thin and lifeless on sustained chords.
                 */
                soundFont: '',
                enableElementHighlighting: false,
                // The app draws its own cursor so the microphone follower and the
                // player can share one highlight and one page-turn pipeline.
                enableCursor: false,
                enableAnimatedBeatCursor: false,
                // Lets alphaTab do the hit testing; the beat it reports is then used
                // to seek, so a tap moves the cursor and playback continues from there.
                enableUserInteraction: true,
                scrollMode: 'off',
                scrollElement: viewportEl
            }
        };

        api = new AT.AlphaTabApi(scoreEl, settings);

        api.error.on(function (err) {
            var message = err && err.message ? err.message : String(err);
            post('error', { message: '无法读取乐谱，请检查文件是否完整。' + (message ? '（' + message + '）' : '') });
        });

        api.scoreLoaded.on(function (score) {
            onScoreLoaded(score);
        });

        api.renderFinished.on(function () {
            onRenderFinished();
        });

        api.playerReady.on(function () {
            playerReady = true;
            post('playerState', { state: 'ready' });
            if (fontWanted) ensureSoundFont();
        });

        api.soundFontLoaded.on(function () {
            soundFontReady = true;
            if (soundFontTimer) {
                clearTimeout(soundFontTimer);
                soundFontTimer = null;
            }
            console.log('[viewer] soundfont loaded');
            post('playerState', { state: 'soundfontLoaded' });
        });

        api.playerStateChanged.on(function (args) {
            var playing = args && args.state === 1;
            if (!playing && ready) post('playbackPosition', {tick: Math.max(0,api.tickPosition)});
            post('playerState', { state: playing ? 'playing' : 'paused' });
        });

        // Playback drives the very same cursor the microphone follower uses, so the
        // page-turn logic needs no separate path for the player.
        api.playerPositionChanged.on(function (args) {
            if (!ready || api.playerState !== 1) return;
            var tick = args && typeof args.currentTick === 'number'
                ? args.currentTick
                : api.tickPosition;
            if (typeof tick !== 'number' || tick < 0) return;
            setCursorTick(tick);
            if (Date.now()-lastPlaybackReport > 200) {
                lastPlaybackReport=Date.now(); post('playbackPosition',{tick:Math.round(tick)});
            }
        });

        // alphaTab only turns a click into a beat through its mouse handler, and a
        // WebView does not reliably synthesise mouse events from a touch. Pointer
        // devices therefore keep using alphaTab's handler, while the touch path
        // hit-tests the finger position itself (see installTapTracking).
        api.beatMouseDown.on(function (beat) {
            if (touchSeen) return;
            var tick = absoluteTickOfBeat(beat);
            if (tick < 0) return;
            seekTo(tick);
        });

        installTapTracking();
    }

    /** Hit-tests a viewport point against the rendered beats, in score coordinates. */
    function beatAtClientPos(clientX, clientY) {
        if (!api || !api.renderer) return null;
        var lookup = api.renderer.boundsLookup;
        if (!lookup || typeof lookup.getBeatAtPos !== 'function') return null;
        var rect = scoreEl.getBoundingClientRect();
        var x = clientX - rect.left;
        var y = clientY - rect.top;
        if (x < 0 || y < 0) return null;
        try {
            var hit = lookup.getBeatAtPos(x, y);
            if (!hit) return null;
            // This alphaTab build hands back the beat itself; older ones wrapped it in
            // a bounds object, so unwrap when a `beat` field is present.
            return hit.beat ? hit.beat : hit;
        } catch (e) {
            return null;
        }
    }

    /*
     * Beats carry a bar-relative `playbackStart`, while the player, the tick cache
     * and the follower timeline all speak absolute ticks. Rebase onto the master bar
     * so a tap lands on the measure it visually hit. Builds that already store an
     * absolute value are detected by the value being past the bar's own start.
     */
    function absoluteTickOfBeat(beat) {
        if (!beat || !api || !api.tickCache) return -1;
        return api.tickCache.getBeatStart(beat);
    }

    function installTapTracking() {
        // The listeners live on the document, so a player retry must not stack a
        // second copy on top of the first.
        if (tapTrackingInstalled) return;
        tapTrackingInstalled = true;
        /*
         * alphaTab installs its own interaction handlers on the notation surface and
         * stops propagation, so a bubbling listener on #stage never sees a finger.
         * Capturing on the document runs before alphaTab and is therefore reliable.
         */
        document.addEventListener('touchstart', function (e) {
            if (e.touches.length !== 1) return;
            touchSeen = true;
            tapStartX = e.touches[0].clientX;
            tapStartY = e.touches[0].clientY;
        }, { passive: true, capture: true });

        document.addEventListener('touchend', function (e) {
            if (!touchSeen) return;
            var touch = e.changedTouches && e.changedTouches[0];
            if (!touch) return;
            var dx = touch.clientX - tapStartX;
            var dy = touch.clientY - tapStartY;
            // Roughly 10px of slop: anything beyond that was a scroll, not a tap.
            if (dx * dx + dy * dy > 100) return;

            if(notationMode==='numbered') return;
            var beat = beatAtClientPos(touch.clientX, touch.clientY);
            var tick = absoluteTickOfBeat(beat);
            if (tick < 0) return;
            seekTo(tick);
        }, { passive: true, capture: true });
    }

    function onScoreLoaded(score) {
        if (score.stylesheet) {
            // 1 = BarNumberDisplay.FirstOfSystem. The MusicXML importer leaves the
            // per-bar value unset, so every bar would otherwise print its number.
            score.stylesheet.barNumberDisplay = 1;
        }

        var info = {
            title: score.title || '',
            artist: score.artist || '',
            masterBars: score.masterBars ? score.masterBars.length : 0,
            tracks: []
        };
        if (score.tracks) {
            for (var i = 0; i < score.tracks.length; i++) {
                info.tracks.push({
                    index: i,
                    name: score.tracks[i].name || ('Track ' + (i + 1)),
                    staves: score.tracks[i].staves ? score.tracks[i].staves.length : 0
                });
            }
        }
        post('scoreLoaded', info);
        try { post('scoreStructure', buildStructure(score)); }
        catch (e) { post('error', { message:e.message || String(e) }); }
    }

    /*
     * Flattens the notated score into per-measure attack events carrying pitch
     * classes. The native follower aligns the microphone chroma against this list,
     * which is why the payload is deliberately pitch-class based: it is octave
     * independent and therefore tolerant of the register a piece is played in.
     */
    function buildStructure(score) {
        if (!selectedTracks) {
            selectedTracks = score.tracks.map(function(t,i) { return {t:t,i:i}; })
                .filter(function(x) { var p=x.t.playbackInfo; return p && p.program >= 0 && p.program <= 7; })
                .map(function(x) { return x.i; });
            if (!selectedTracks.length) selectedTracks = score.tracks.map(function(t,i) { return i; });
        }
        return window.ScoreGraphExporter.build(AT, score, selectedTracks, selectedStaffs);
    }

    function onRenderFinished() {
        layoutVersion++;
        if(notationMode==='numbered') renderNumbered();
        buildLayout();
        navigationAnchor.reset(followAnchorTick,systemForTick(followAnchorTick));
        lastFollowedSystem = -1; requestedPage = -1;
        ready = true;
        var barCounts = [];
        for (var i = 0; i < systems.length; i++) barCounts.push(systems[i].bars.length);
        var staffCounts = [];
        var lookup = api.renderer ? api.renderer.boundsLookup : null;
        if (lookup && lookup.staffSystems) {
            for (var j = 0; j < lookup.staffSystems.length; j++) {
                var system = lookup.staffSystems[j];
                var firstBar = system.bars && system.bars.length > 0 ? system.bars[0] : null;
                staffCounts.push(firstBar && firstBar.bars ? firstBar.bars.length : -1);
            }
        }
        console.log('[viewer] tracks=' + (api.score ? api.score.tracks.length : -1) +
            ' systems=' + systems.length +
            ' barsPerSystem=' + barCounts.join(',') +
            ' stavesPerSystem=' + staffCounts.join(','));
        post('renderFinished', {
            pageCount: pages.length,
            systemCount: systems.length,
            measureCount: countMeasures()
        });
        reportDisplayedPage();

        // A relayout (rotation, scale change) invalidates the cached element
        // positions, so the cursor is placed again at wherever it was.
        if (lastCursorTick >= 0) setCursorTick(lastCursorTick);
    }

    function countMeasures() {
        var total = 0;
        for (var i = 0; i < systems.length; i++) {
            total += systems[i].bars.length;
        }
        return total;
    }

    /* ------------------------------------------------------------------ */
    /* Layout model                                                        */
    /* ------------------------------------------------------------------ */

    function surfaceOffsetY() {
        if(notationMode==='numbered') return 0;
        var sr = scoreEl.getBoundingClientRect();
        var st = stageEl.getBoundingClientRect();
        return sr.top - st.top;
    }

    function stageYOf(surfaceY) {
        return surfaceOffsetY() + surfaceY;
    }

    function buildLayout() {
        if(notationMode==='numbered') { buildNumberedLayout(); return; }
        systems = [];
        var lookup = api.renderer ? api.renderer.boundsLookup : null;
        if (lookup && lookup.staffSystems) {
            for (var i = 0; i < lookup.staffSystems.length; i++) {
                var sys = lookup.staffSystems[i];
                var bars = [];
                if (sys.bars) {
                    for (var j = 0; j < sys.bars.length; j++) {
                        var bar = sys.bars[j];
                        bars.push({
                            index: bar.index,
                            x: bar.visualBounds.x,
                            y: bar.visualBounds.y,
                            w: bar.visualBounds.w,
                            h: bar.visualBounds.h
                        });
                    }
                }
                /*
                 * The top staff of a piano grand staff is the treble one, and the
                 * cursor rides on it for the whole system so it never hops between the
                 * hands. alphaTab's staff system carries no staff-level bounds, but
                 * every master bar inside it holds one bar per staff — the first of
                 * those is the treble staff.
                 */
                var trebleTop = sys.realBounds.y;
                var trebleHeight = sys.realBounds.h;
                var firstMasterBar = sys.bars && sys.bars.length > 0 ? sys.bars[0] : null;
                var staffBars = firstMasterBar && firstMasterBar.bars ? firstMasterBar.bars : null;
                if (staffBars && staffBars.length > 0) {
                    var trebleBounds = staffBars[0].realBounds || staffBars[0].visualBounds;
                    if (trebleBounds && trebleBounds.h > 0) {
                        trebleTop = trebleBounds.y;
                        trebleHeight = trebleBounds.h;
                    }
                }
                systems.push({
                    index: i,
                    y: sys.realBounds.y,
                    h: sys.realBounds.h,
                    trebleTop: trebleTop,
                    trebleHeight: trebleHeight,
                    bars: bars
                });
            }
        }
        computePages();
        if (cursorLayerEl) {
            cursorLayerEl.style.height = scoreEl.getBoundingClientRect().height + 'px';
        }
    }

    /*
     * Page breaks are derived from the rendered staff systems instead of relying on
     * alphaTab's internal pagination, so the "last measure of the page" is always
     * an exact, queryable value for the auto page turn state machine.
     */
    function computePages() {
        pages = [];
        systemPageIndex = new Array(systems.length).fill(0);
        if (systems.length === 0) return;

        var viewportHeight = Math.max(100,viewportEl.clientHeight-84);
        var current = null;

        for (var i = 0; i < systems.length; i++) {
            var sys = systems[i];
            var top = stageYOf(sys.y);
            var bottom = stageYOf(sys.y + sys.h);

            if (current === null) {
                current = {
                    index: 0,
                    topY: Math.max(0, top - PAGE_TOP_MARGIN),
                    systemFrom: i,
                    systemTo: i,
                    lastMasterBar: -1
                };
            } else if (bottom - current.topY > viewportHeight) {
                pages.push(current);
                current = {
                    index: pages.length,
                    topY: Math.max(0, top - PAGE_TOP_MARGIN),
                    systemFrom: i,
                    systemTo: i,
                    lastMasterBar: -1
                };
            }

            current.systemTo = i;
            if (sys.bars.length > 0) {
                current.lastMasterBar = sys.bars[sys.bars.length - 1].index;
            }
            systemPageIndex[i] = current.index;
        }

        pages.push(current);
    }

    function pageIndexOfMasterBar(masterBarIndex) {
        for (var i = 0; i < systems.length; i++) {
            var bars = systems[i].bars;
            for (var j = 0; j < bars.length; j++) {
                if (bars[j].index === masterBarIndex) {
                    return systemPageIndex[i];
                }
            }
        }
        return -1;
    }

    function systemIndexOfMasterBar(masterBarIndex) {
        for (var i = 0; i < systems.length; i++) {
            var bars = systems[i].bars;
            for (var j = 0; j < bars.length; j++) {
                if (bars[j].index === masterBarIndex) return i;
            }
        }
        return -1;
    }

    /* ------------------------------------------------------------------ */
    /* Cursor overlay                                                      */
    /* ------------------------------------------------------------------ */

    function masterBarIndexOfBeat(beat) {
        try {
            if (beat && beat.voice && beat.voice.bar && beat.voice.bar.masterBar) {
                return beat.voice.bar.masterBar.index;
            }
        } catch (e) { /* fall through */ }
        return -1;
    }

    function ensureCursorElements() {
        if (!beatCursorEl) {
            beatCursorEl = document.createElement('div');
            beatCursorEl.className = 'beat-cursor';
            cursorLayerEl.appendChild(beatCursorEl);
        }
    }

    function hideCursor() {
        if (beatCursorEl) beatCursorEl.style.display = 'none';
        numberedEl.querySelectorAll('.active').forEach(function(e){e.classList.remove('active');});
    }

    function resolveBeat(tick) {
        if (!api || !api.score || !api.renderer) return null;
        var lookup = api.renderer.boundsLookup;
        if (!lookup) return null;

        var trackIds = new Set();
        for (var i = 0; i < api.score.tracks.length; i++) trackIds.add(i);

        var result = null;
        try {
            result = api.tickCache.findBeat(trackIds, tick);
        } catch (e) {
            result = null;
        }
        if (!result || !(result.beat || result.currentBeat)) return null;
        result.beat = result.beat || result.currentBeat;

        var beatBounds = lookup.findBeat(result.beat);
        if (!beatBounds) return null;

        return { beat: result.beat, bounds: beatBounds, lookup: lookup };
    }

    function setCursorTick(tick) {
        if (!ready) return null;
        lastCursorTick = tick;
        if(notationMode==='numbered') return numberedCursor(tick);
        var resolved = resolveBeat(tick);
        if (!resolved) {
            hideCursor();
            return null;
        }

        ensureCursorElements();

        var offsetY = surfaceOffsetY();
        var bounds = resolved.bounds;
        var visual = bounds.visualBounds;

        var masterBarIndex = masterBarIndexOfBeat(resolved.beat);
        var pageIndex = pageIndexOfMasterBar(masterBarIndex);
        var isLastMeasureOfPage = false;
        var navigationBar=masterBarIndex;
        if(followAnchorTick!==null) {var anchored=resolveBeat(followAnchorTick);if(anchored)navigationBar=masterBarIndexOfBeat(anchored.beat);}
        var systemIndex = navigationBar >= 0 ? systemIndexOfMasterBar(navigationBar) : -1;

        /*
         * The cursor is one bar spanning the top (treble) staff of the current system.
         * Anchoring it to the system instead of to the struck note keeps it from
         * hopping up and down between the two staves of a piano grand staff.
         */
        var system = systemIndex >= 0 ? systems[systemIndex] : null;
        var cursorTop;
        var cursorHeight;
        if (system && system.trebleHeight > 0) {
            cursorTop = offsetY + system.trebleTop;
            cursorHeight = system.trebleHeight;
        } else {
            cursorTop = offsetY + visual.y;
            cursorHeight = Math.max(26, visual.h + 4);
        }

        beatCursorEl.style.display = 'block';
        beatCursorEl.style.left = (bounds.onNotesX - 1.5) + 'px';
        beatCursorEl.style.top = cursorTop + 'px';
        beatCursorEl.style.height = cursorHeight + 'px';

        if (masterBarIndex >= 0 && pageIndex >= 0) {
            isLastMeasureOfPage = pages[pageIndex].lastMasterBar === masterBarIndex;
        }

        // Following advances a line at a time: the view is only re-anchored when the
        // music moves on to another staff system, so a manual scroll within the
        // current line is never fought.
        if (followCursor && !userBrowsing && navigationMode === 'line' && systemIndex >= 0 && systemIndex !== lastFollowedSystem) {
            lastFollowedSystem = systemIndex;
            ensureSystemVisible(systemIndex, true);
        }

        if (masterBarIndex !== lastMasterBarIndex) {
            lastMasterBarIndex = masterBarIndex;
            post('positionChanged', {
                measure: masterBarIndex,
                page: pageIndex,
                pageCount: pages.length,
                isLastMeasureOfPage: isLastMeasureOfPage
            });
        }

        return {
            measure: masterBarIndex,
            page: pageIndex,
            pageCount: pages.length,
            isLastMeasureOfPage: isLastMeasureOfPage,
            x: bounds.onNotesX,
            y: offsetY + visual.y
        };
    }

    /* ------------------------------------------------------------------ */
    /* Scrolling / page navigation                                         */
    /* ------------------------------------------------------------------ */

    function scrollToPage(index, smooth) {
        if (index < 0 || index >= pages.length) return false;
        viewportEl.scrollTo({
            top: pages[index].topY,
            behavior: smooth === false ? 'auto' : 'smooth'
        });
        return true;
    }

    function scrollToMasterBar(masterBarIndex, smooth) {
        var systemIndex = systemIndexOfMasterBar(masterBarIndex);
        if (systemIndex < 0) return false;
        var top = Math.max(0, stageYOf(systems[systemIndex].y) - PAGE_TOP_MARGIN);
        viewportEl.scrollTo({
            top: top,
            behavior: smooth === false ? 'auto' : 'smooth'
        });
        return true;
    }

    function scrollToSystem(index, smooth) {
        if (index < 0 || index >= systems.length) return false;
        var anchor = viewportEl.clientHeight * FOLLOW_ANCHOR_RATIO;
        viewportEl.scrollTo({
            top: Math.max(0, stageYOf(systems[index].y) - anchor),
            behavior: smooth === false ? 'auto' : 'smooth'
        });
        return true;
    }

    /**
     * Brings a staff system back into view, but only when it has drifted out of the
     * comfortable band. A system that is already on screen is left alone, which is
     * what makes the follow advance line by line instead of snapping to a page edge.
     */
    function ensureSystemVisible(index, smooth) {
        if (index < 0 || index >= systems.length) return false;
        var system = systems[index];
        var top = stageYOf(system.y);
        var bottom = top + system.h;
        var viewTop = viewportEl.scrollTop;
        var viewBottom = viewTop + viewportEl.clientHeight;
        var margin = Math.min(viewportEl.clientHeight*.25, Math.max(84, viewportEl.clientHeight * 0.06));
        if (top >= viewTop + margin && bottom <= viewBottom - margin) return false;
        return scrollToSystem(index, smooth);
    }

    function setFollowCursor(enabled) {
        followCursor = !!enabled;
        if (!followCursor) lastFollowedSystem = -1;
        return followCursor;
    }

    function currentPageIndex() {
        var scrollTop = viewportEl.scrollTop;
        var best = 0;
        for (var i = 0; i < pages.length; i++) {
            if (pages[i].topY <= scrollTop + Math.min(100,viewportEl.clientHeight*.15) + 8) best = i;
        }
        return best;
    }

    /*
     * The page the user is actually looking at is a scroll position, not the page
     * holding the cursor, so it is reported separately. Native needs both: the
     * displayed page drives the page indicator, the cursor page drives auto-turn.
     */
    function reportDisplayedPage() {
        scrollScheduled = false;
        if (!ready || pages.length === 0) return;
        var index = currentPageIndex();
        if (index === lastReportedPage) return;
        lastReportedPage = index;
        post('pageChanged', { page: index, pageCount: pages.length });
    }

    viewportEl.addEventListener('scroll', function () {
        if (scrollScheduled) return;
        scrollScheduled = true;
        window.requestAnimationFrame(reportDisplayedPage);
    }, { passive: true });

    /* ------------------------------------------------------------------ */
    /* Public API                                                          */
    /* ------------------------------------------------------------------ */

    /*
     * alphaTab exposes no public soundfont-failure event, so a missing or
     * unreachable soundfont is caught by a watchdog instead: if nothing arrives in
     * time the native layer is told audio is unavailable rather than waiting forever.
     *
     * The bank is a 9.5 MB sampled piano, and decoding it on a slower device can
     * legitimately take tens of seconds. A short timeout would report a failure that
     * is really just slowness, and the retry it offers would start the same long
     * decode again -- which reads as a player that never becomes ready. So the
     * timeout is deliberately generous; it only exists to catch a request that will
     * never complete.
     */
    var SOUNDFONT_TIMEOUT_MS = 45000;

    function armSoundFontWatchdog() {
        if (soundFontTimer) clearTimeout(soundFontTimer);
        soundFontTimer = setTimeout(function () {
            soundFontTimer = null;
            if (!soundFontReady) {
                console.log('[viewer] soundfont load timed out');
                fontWanted = false;
                if (fontWaitTimer) { clearTimeout(fontWaitTimer); fontWaitTimer=null; }
                post('playerState', { state: 'soundfontFailed' });
            }
        }, SOUNDFONT_TIMEOUT_MS);
    }

    async function loadScore(url, nextGeneration, restoreTick) {
        if ((nextGeneration || 0) !== generation) layoutVersion = 0;
        generation = nextGeneration || 0; followAnchorTick=null; navigationAnchor.reset(null,-1);
        selectedTracks = null; selectedStaffs = null; userBrowsing = false;
        var request = ++loadRequest;
        if (!api) return false;
        lastScoreUrl = url;
        ready = false;
        lastCursorTick = typeof restoreTick === "number" ? restoreTick : -1;
        hideCursor();
        lastMasterBarIndex = -1;
        lastReportedPage = -1;
        try {
            var response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) {
                post('error', { message: '无法读取乐谱文件 (' + response.status + ')' });
                return false;
            }
            var buffer = await response.arrayBuffer();
            if (request !== loadRequest) return false;
            /*
             * The synth decodes the soundfont once and keeps it for the lifetime of
             * the page, so a second score must not wait for a `soundFontLoaded` event
             * that alphaTab will never send again. The native side resets its own
             * readiness on every import, so the state is re-announced here instead.
             */
            if (soundFontReady) {
                post('playerState', { state: 'soundfontLoaded' });
            }
            api.load(new Uint8Array(buffer));
            return true;
        } catch (e) {
            post('error', { message: '乐谱加载失败: ' + (e && e.message ? e.message : e) });
            return false;
        }
    }

    /**
     * Rebuilds the player after a soundfont failure. Only a fresh AlphaTabApi gets a
     * new synth, which is what makes alphaTab fetch and decode the soundfont again.
     */
    function retrySoundFont() {
        var restoreTick=lastCursorTick;
        if (fontWaitTimer) { clearTimeout(fontWaitTimer); fontWaitTimer=null; }
        if (!api) return false;
        if (soundFontTimer) {
            clearTimeout(soundFontTimer);
            soundFontTimer = null;
        }
        try {
            api.destroy();
        } catch (e) {
            /* the old instance may already be half torn down */
        }
        api = null;
        ready = false;
        playerReady = false;
        soundFontReady = false; fontRequested = false;
        lastMasterBarIndex = -1;
        lastReportedPage = -1;
        initApi();
        if (lastScoreUrl) loadScore(lastScoreUrl,generation,restoreTick);
        ensureSoundFont();
        return true;
    }

    function setScale(scale) {
        if (!api) return;
        api.settings.display.scale = scale;
        api.updateSettings();
        api.render();
    }

    function relayout() {
        if (!api || !ready) return;
        buildLayout();
    }

    /* ------------------------------------------------------------------ */
    /* Playback                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * Moves the play position. Safe to call before the soundfont has finished
     * loading: the cursor follows either way, only the audio position is skipped.
     */
    function seekTo(tick) {
        if (!api) return false;
        var target = Math.max(0, Math.round(tick));
        userBrowsing = false;
        if(followAnchorTick!==null){followAnchorTick=target;navigationAnchor.reset(target,systemForTick(target));}
        post('seekRequested', { tick: target });
        try {
            api.tickPosition = target;
        } catch (e) {
            /* player not ready; the cursor still moves */
        }
        var placed = setCursorTick(target);
        // A seek is an explicit jump, so a position on another page is brought into
        // view immediately instead of waiting for a page turn. Staying put avoids
        // snapping the view back to the page top when the tap lands on the same page.
        if (placed && placed.page >= 0 && placed.page !== currentPageIndex()) {
            scrollToPage(placed.page, false);
        }
        return true;
    }

    function play() {
        if (!api || !ready) return false;
        if (!soundFontReady) { ensureSoundFont(); return false; }
        if(lastCursorTick>=0) api.tickPosition=lastCursorTick;
        api.play();
        return true;
    }

    function pause() {
        if (!api) return false;
        api.pause();
        return true;
    }

    function togglePlay() {
        if (!api || !ready) return false;
        api.playPause();
        return true;
    }

    function stop() {
        if (!api) return false;
        api.stop();
        return true;
    }

    function isPlaying() {
        return !!api && api.playerState === 1;
    }

    function getPosition() {
        if (!api) return -1;
        var tick = api.tickPosition;
        return typeof tick === 'number' ? tick : -1;
    }

    function ensureSoundFont() {
        fontWanted = true;
        if (soundFontReady || fontRequested) return;
        if (!soundFontTimer) armSoundFontWatchdog();
        // playerReady means MIDI + soundfont are both ready; it cannot gate the
        // first font load. Wait for the synth instance itself instead.
        if (!api.player || !api.player.isReady) {
            if (!fontWaitTimer) {
                var waitingApi=api;
                fontWaitTimer=setTimeout(function() {
                    fontWaitTimer=null;
                    if(api===waitingApi && fontWanted) ensureSoundFont();
                },100);
            }
            return;
        }
        fontRequested = true;
        api.loadSoundFont('../alphatab/soundfont/piano.sf2');
    }
    function setNavigation(mode, allowed) {
        navigationMode = mode; followCursor = !!allowed;
    }
    function resumeFollow() {
        userBrowsing = false; requestedPage = -1; lastFollowedSystem = -1;
        if (lastCursorTick >= 0) { var r = setCursorTick(lastCursorTick); if (r) scrollToMasterBar(r.measure || lastMasterBarIndex); }
    }
    function browse() {
        if (!userBrowsing) { requestedPage = -1; userBrowsing = true; post('userBrowsing'); }
    }
    viewportEl.addEventListener('wheel', browse, {passive:true});
    viewportEl.addEventListener('touchmove', function(e) {
        if (e.touches.length && Math.abs(e.touches[0].clientY - tapStartY) > 12) browse();
    }, {passive:true});
    function renderNumbered() {
        numberedGraph=buildStructure(api.score); numberedGraph.selectedStaffs=selectedStaffs;
        window.NumberedScore.render(numberedEl,numberedGraph,api.score,function(tick,measure){
            var visits=numberedGraph.bars.filter(function(b){return b.index===measure;});
            var base=visits[0], current=visits.find(function(b){return lastCursorTick>=b.start && lastCursorTick<b.end;}) || base;
            seekTo(current.start+(tick-base.start));
        });
    }
    function buildNumberedLayout() {
        systems=[];
        numberedEl.querySelectorAll('.numbered-system').forEach(function(el,i){
            var y=el.offsetTop;
            systems.push({index:i,y:y,h:el.offsetHeight,trebleTop:y,trebleHeight:el.offsetHeight,
                bars:Array.from(el.querySelectorAll('.numbered-bar')).map(function(b){return {index:Number(b.dataset.measure)};})});
        });
        computePages(); cursorLayerEl.style.height='0px';
    }
    function systemForTick(tick) {
        if(tick===null)return -1;
        if(notationMode==='numbered' && numberedGraph){var bar=numberedGraph.bars.find(function(b){return tick>=b.start && tick<b.end;});return bar?systemIndexOfMasterBar(bar.index):-1;}
        var resolved=resolveBeat(tick);return resolved?systemIndexOfMasterBar(masterBarIndexOfBeat(resolved.beat)):-1;
    }
    function setNotationMode(mode) {
        mode=mode==='numbered'?'numbered':'staff';
        if(mode===notationMode)return;
        notationMode=mode;
        // Keep alphaTab at its real width for layout and playback mapping.
        scoreEl.style.position=mode==='numbered'?'absolute':'';
        scoreEl.style.visibility=mode==='numbered'?'hidden':'';
        scoreEl.style.pointerEvents=mode==='numbered'?'none':'';
        numberedEl.hidden=mode!=='numbered';
        if(beatCursorEl)beatCursorEl.style.display='none';
        if(api.score && ready)onRenderFinished();
    }
    function numberedCursor(tick) {
        if(!numberedGraph)return null;
        var bar=numberedGraph.bars.find(function(b){return tick>=b.start && tick<b.end;}) || numberedGraph.bars[numberedGraph.bars.length-1];
        if(!bar)return null;
        var first=numberedGraph.bars.find(function(b){return b.index===bar.index;}), local=tick-bar.start;
        numberedEl.querySelectorAll('.active').forEach(function(e){e.classList.remove('active');});
        var el=numberedEl.querySelector('[data-measure="'+bar.index+'"]');
        if(el) {
            el.classList.add('active');
            el.querySelectorAll('.numbered-lane').forEach(function(row){
                var target=first.start+local;
                Array.from(row.children).filter(function(c){return Number(c.dataset.tick)<=target && Number(c.dataset.end)>target;}).forEach(function(c){c.classList.add('active');});
            });
        }
        var anchorBar=followAnchorTick===null?null:numberedGraph.bars.find(function(b){return followAnchorTick>=b.start && followAnchorTick<b.end;});
        var si=systemIndexOfMasterBar(anchorBar?anchorBar.index:bar.index), page=pageIndexOfMasterBar(bar.index);
        if(followCursor && !userBrowsing && navigationMode==='line' && si!==lastFollowedSystem){lastFollowedSystem=si;ensureSystemVisible(si,true);}
        if(lastMasterBarIndex!==bar.index){lastMasterBarIndex=bar.index;post('positionChanged',{measure:bar.index,page:page,pageCount:pages.length,isLastMeasureOfPage:pages[page]&&pages[page].lastMasterBar===bar.index});}
        return {measure:bar.index,page:page,pageCount:pages.length};
    }
    window.PianoScoreViewer = {
        setFollowAnchor:function(tick){tick=typeof tick==='number'?tick:null;followAnchorTick=navigationAnchor.update(tick,systemForTick(tick),performance.now());},
        setNotationMode:setNotationMode,
        setPracticeSpeed:function(speed){api.playbackSpeed=speed;},
        ensureVisible: function(measure) {
            if (userBrowsing || !followCursor) return;
            if(followAnchorTick!==null) {
                if(notationMode==='numbered' && numberedGraph){var anchoredBar=numberedGraph.bars.find(function(b){return followAnchorTick>=b.start&&followAnchorTick<b.end;});if(anchoredBar)measure=anchoredBar.index;}
                else {var anchored=resolveBeat(followAnchorTick);if(anchored)measure=masterBarIndexOfBeat(anchored.beat);}
            }
            var page = pageIndexOfMasterBar(measure);
            if (page >= 0 && page !== requestedPage && page !== currentPageIndex()) {
                requestedPage = page;
                var previous = pages[Math.max(0,page-1)];
                var overlap = previous && page > 0 ? Math.min(100, viewportEl.clientHeight * .15) : 0;
                viewportEl.scrollTo({top: Math.max(0,pages[page].topY-overlap), behavior:'smooth'});
            }
        },
        diagnostics: function() { return { generation:generation, layoutVersion:layoutVersion, tick:lastCursorTick, playing:api.playerState, font:api.settings.player.soundFont, fontReady:soundFontReady, request:fontRequested, synthReady:playerReady, ready:ready, notation:notationMode, followAnchor:followAnchorTick, followedSystem:lastFollowedSystem }; },
        exportGraph: function() { return buildStructure(api.score); },
        ensureSoundFont: ensureSoundFont,
        setNavigation: setNavigation,
        resumeFollow: resumeFollow,
        setStaffs: function(staffs) { selectedStaffs=staffs; post('scoreStructure',buildStructure(api.score)); if(notationMode==='numbered')onRenderFinished(); },
        setTracks: function(tracks) { selectedTracks = tracks; post('scoreStructure', buildStructure(api.score)); if(notationMode==='numbered')onRenderFinished(); },
        loadScore: loadScore,
        setCursorTick: setCursorTick,
        hideCursor: hideCursor,
        scrollToPage: scrollToPage,
        scrollToMasterBar: scrollToMasterBar,
        currentPageIndex: currentPageIndex,
        setScale: setScale,
        relayout: relayout,
        showHint: showHint,
        getPages: function () { return pages; },
        getSystems: function () { return systems; },
        getPageForMasterBar: pageIndexOfMasterBar,
        isReady: function () { return ready; },
        seekTo: seekTo,
        play: play,
        pause: pause,
        togglePlay: togglePlay,
        stop: stop,
        isPlaying: isPlaying,
        getPosition: getPosition,
        retrySoundFont: retrySoundFont,
        _hit: function (cx, cy) {
            var beat = beatAtClientPos(cx, cy);
            if (!beat) return { beat: null };
            var bar = beat.voice ? beat.voice.bar : null;
            var bounds = api.renderer.boundsLookup.findBeat(beat);
            return {
                x: cx,
                barIndex: bar ? bar.index : -1,
                mbIndex: bar && bar.masterBar ? bar.masterBar.index : -1,
                mbStart: bar && bar.masterBar ? bar.masterBar.start : -1,
                voiceIndex: beat.voice ? beat.voice.index : -1,
                ps: beat.playbackStart,
                abs: beat.absolutePlaybackStart,
                boundsX: bounds ? Math.round(bounds.realBounds.x) : -1,
                beatCount: bar && bar.voices && beat.voice ? beat.voice.beats.length : -1
            };
        },
        _bar: function (mbIndex) {
            var score = api.score;
            var out = [];
            for (var s = 0; s < score.tracks[0].staves.length; s++) {
                var bar = score.tracks[0].staves[s].bars[mbIndex];
                for (var v = 0; v < bar.voices.length; v++) {
                    var beats = bar.voices[v].beats;
                    var list = [];
                    for (var b = 0; b < beats.length; b++) {
                        var bb = api.renderer.boundsLookup.findBeat(beats[b]);
                        list.push({
                            ps: beats[b].playbackStart,
                            abs: beats[b].absolutePlaybackStart,
                            x: bb ? Math.round(bb.realBounds.x) : -1
                        });
                    }
                    out.push({ staff: s, voice: v, beats: list });
                }
            }
            return out;
        }
    };

    /*
     * Rotating the device changes the usable width, so alphaTab has to lay the
     * measures out again before the systems and page breaks are recomputed. The
     * notation scale is re-evaluated as well: a phone in portrait gets a smaller
     * one so a line still carries a few measures.
     */
    function scheduleRelayout() {
        if (!ready) return;
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
            resizeTimer = null;
            if (!api) return;
            var scale = responsiveScale();
            var scaleChanged = Math.abs(api.settings.display.scale - scale) > 0.001;
            try {
                if (scaleChanged) {
                    api.settings.display.scale = scale;
                    api.updateSettings();
                }
                api.render();
            } catch (e) {
                buildLayout();
            }
        }, 220);
    }

    window.addEventListener('resize', scheduleRelayout);
    window.addEventListener('orientationchange', scheduleRelayout);

    initApi();
    post('viewerReady', {});
})();
