/*
 * 平台层：设备识别、横竖屏、主题与偏好持久化。
 *
 * 主题不是随手挑的几个颜色，而是把 Android 端 ui/Theme.kt 的 tonalScheme()
 * 原样搬到 JS：同一个色相走同一套 Material 3 色调生成，所以网页端与手机端
 * 选“典雅紫”“松石绿”时拿到的是完全一样的配色。
 */
(function (global) {
    'use strict';

    /* ------------------------------------------------------------------ */
    /* 偏好设置                                                             */
    /* ------------------------------------------------------------------ */

    var PREFS_KEY = 'piano_follower_settings';

    var THEME_MODES = [
        { id: 'System', label: '跟随系统' },
        { id: 'Light', label: '浅色' },
        { id: 'Dark', label: '深色' }
    ];

    /*
     * 与 Android 端 ThemePalette 一一对应。hue = -1 表示“跟随壁纸”，
     * 浏览器拿不到系统壁纸，因此退化为经典蓝并在界面上如实说明。
     */
    var PALETTES = [
        { id: 'Dynamic', label: '跟随壁纸', hue: -1, webFallback: '经典蓝' },
        { id: 'Blue', label: '经典蓝', hue: 212 },
        { id: 'Purple', label: '典雅紫', hue: 268 },
        { id: 'Teal', label: '松石绿', hue: 172 },
        { id: 'Amber', label: '暖琥珀', hue: 38 },
        { id: 'Rose', label: '玫瑰粉', hue: 336 }
    ];

    function Settings() {
        this.mode = 'System';
        this.palette = 'Dynamic';
        this.scrollDurationSeconds = 180;
        this.load();
    }

    Settings.prototype.load = function () {
        var raw = null;
        try {
            raw = global.localStorage.getItem(PREFS_KEY);
        } catch (e) {
            raw = null;
        }
        if (!raw) return;
        try {
            var parsed = JSON.parse(raw);
            if (THEME_MODES.some(function (m) { return m.id === parsed.theme_mode; })) {
                this.mode = parsed.theme_mode;
            }
            if (PALETTES.some(function (p) { return p.id === parsed.theme_palette; })) {
                this.palette = parsed.theme_palette;
            }
            if (typeof parsed.scroll_duration_seconds === 'number' && parsed.scroll_duration_seconds > 0) {
                this.scrollDurationSeconds = parsed.scroll_duration_seconds;
            }
        } catch (e) {
            /* 存坏了就退回默认值，不要让设置页打不开 */
        }
    };

    Settings.prototype.save = function () {
        try {
            global.localStorage.setItem(PREFS_KEY, JSON.stringify({
                theme_mode: this.mode,
                theme_palette: this.palette,
                scroll_duration_seconds: this.scrollDurationSeconds
            }));
        } catch (e) {
            /* 隐私模式下 localStorage 可能直接抛错，静默忽略 */
        }
    };

    Settings.prototype.setMode = function (mode) {
        if (this.mode === mode) return false;
        this.mode = mode;
        this.save();
        return true;
    };

    Settings.prototype.setPalette = function (palette) {
        if (this.palette === palette) return false;
        this.palette = palette;
        this.save();
        return true;
    };

    Settings.prototype.setScrollDuration = function (seconds) {
        var value = Math.max(20, Math.min(1800, Math.round(seconds)));
        if (this.scrollDurationSeconds === value) return false;
        this.scrollDurationSeconds = value;
        this.save();
        return true;
    };

    /* ------------------------------------------------------------------ */
    /* 设备识别                                                             */
    /* ------------------------------------------------------------------ */

    var DEVICE_PHONE = 'phone';
    var DEVICE_TABLET = 'tablet';
    var DEVICE_DESKTOP = 'desktop';

    /*
     * UA 只用来判断“设备形态”，不做特性嗅探：
     *   - iPad 从 iPadOS 13 起把自己报成 Macintosh，所以补一条触摸点数的判据；
     *   - Android 平板与手机的差别就在 UA 里有没有 "Mobile"；
     *   - 桌面端还可能存在窄窗口，形态与方向的最终裁决交给 CSS 断点与 matchMedia。
     */
    function detectDevice(ua, platform, maxTouchPoints) {
        ua = ua || '';
        platform = platform || '';
        maxTouchPoints = maxTouchPoints || 0;

        if (/iPad/i.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1)) return DEVICE_TABLET;
        if (/Tablet|PlayBook|Silk/i.test(ua)) return DEVICE_TABLET;
        if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? DEVICE_PHONE : DEVICE_TABLET;
        if (/iPhone|iPod/i.test(ua)) return DEVICE_PHONE;
        if (/Windows Phone|IEMobile|BlackBerry|Opera Mini/i.test(ua)) return DEVICE_PHONE;
        if (/Mobi/i.test(ua)) return DEVICE_PHONE;
        return DEVICE_DESKTOP;
    }

    function detectPlatformLabel(ua, device) {
        ua = ua || '';
        if (/iPad/i.test(ua)) return 'iPadOS';
        if (/iPhone|iPod/i.test(ua)) return 'iOS';
        if (/Android/i.test(ua)) return 'Android';
        if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
        if (/Windows/i.test(ua)) return 'Windows';
        if (/CrOS/i.test(ua)) return 'ChromeOS';
        if (/Linux/i.test(ua)) return 'Linux';
        return device === DEVICE_DESKTOP ? '桌面浏览器' : '未知平台';
    }

    /* ------------------------------------------------------------------ */
    /* 主题：与 Theme.kt 的 tonalScheme() 同源                              */
    /* ------------------------------------------------------------------ */

    function hsl(h, s, l) {
        return 'hsl(' + round(h, 1) + ', ' + round(s * 100, 1) + '%, ' + round(l * 100, 1) + '%)';
    }

    function round(value, digits) {
        var factor = Math.pow(10, digits);
        return Math.round(value * factor) / factor;
    }

    function hslToRgb(h, s, l) {
        h = ((h % 360) + 360) % 360 / 360;
        if (s === 0) return [l, l, l];
        var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        var p = 2 * l - q;
        return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)];
    }

    function hueToRgb(p, q, t) {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    }

    function relativeLuminance(h, s, l) {
        var rgb = hslToRgb(h, s, l).map(function (channel) {
            return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    }

    /** Theme.kt 里 Warning 的两档取值：深色用亮琥珀，浅色用深琥珀。 */
    var WARNING_DARK = '#FFB74D';
    var WARNING_LIGHT = '#B26A00';

    function tonalScheme(hue, dark) {
        var accent = ((hue % 360) + 360) % 360;
        var complement = (accent + 48) % 360;

        if (dark) {
            return {
                '--primary': hsl(accent, 0.60, 0.76),
                '--on-primary': hsl(accent, 0.60, 0.18),
                '--primary-container': hsl(accent, 0.48, 0.32),
                '--on-primary-container': hsl(accent, 0.52, 0.92),
                '--inverse-primary': hsl(accent, 0.58, 0.42),
                '--secondary': hsl(accent, 0.24, 0.74),
                '--on-secondary': hsl(accent, 0.24, 0.18),
                '--secondary-container': hsl(accent, 0.20, 0.30),
                '--on-secondary-container': hsl(accent, 0.22, 0.92),
                '--tertiary': hsl(complement, 0.46, 0.74),
                '--on-tertiary': hsl(complement, 0.46, 0.18),
                '--tertiary-container': hsl(complement, 0.38, 0.30),
                '--on-tertiary-container': hsl(complement, 0.40, 0.92),
                '--error': '#FFB4AB',
                '--on-error': '#690005',
                '--error-container': '#93000A',
                '--on-error-container': '#FFDAD6',
                '--background': hsl(accent, 0.14, 0.07),
                '--on-background': hsl(accent, 0.10, 0.93),
                '--surface': hsl(accent, 0.14, 0.08),
                '--on-surface': hsl(accent, 0.10, 0.93),
                '--surface-variant': hsl(accent, 0.14, 0.20),
                '--on-surface-variant': hsl(accent, 0.12, 0.79),
                '--outline': hsl(accent, 0.10, 0.46),
                '--outline-variant': hsl(accent, 0.10, 0.28),
                '--inverse-surface': hsl(accent, 0.10, 0.93),
                '--inverse-on-surface': hsl(accent, 0.14, 0.18),
                '--warning': WARNING_DARK,
                '--scrim': 'rgba(0, 0, 0, 0.62)',
                '--score-paper': '#FFFFFF',
                '--score-ink': '#14181D'
            };
        }

        return {
            '--primary': hsl(accent, 0.56, 0.42),
            '--on-primary': hsl(accent, 0.40, 0.99),
            '--primary-container': hsl(accent, 0.62, 0.90),
            '--on-primary-container': hsl(accent, 0.72, 0.18),
            '--inverse-primary': hsl(accent, 0.62, 0.76),
            '--secondary': hsl(accent, 0.22, 0.44),
            '--on-secondary': hsl(accent, 0.20, 0.99),
            '--secondary-container': hsl(accent, 0.30, 0.90),
            '--on-secondary-container': hsl(accent, 0.32, 0.16),
            '--tertiary': hsl(complement, 0.42, 0.42),
            '--on-tertiary': hsl(complement, 0.36, 0.99),
            '--tertiary-container': hsl(complement, 0.50, 0.90),
            '--on-tertiary-container': hsl(complement, 0.56, 0.16),
            '--error': '#BA1A1A',
            '--on-error': '#FFFFFF',
            '--error-container': '#FFDAD6',
            '--on-error-container': '#410002',
            '--background': hsl(accent, 0.45, 0.985),
            '--on-background': hsl(accent, 0.30, 0.11),
            '--surface': hsl(accent, 0.45, 0.99),
            '--on-surface': hsl(accent, 0.30, 0.11),
            '--surface-variant': hsl(accent, 0.30, 0.91),
            '--on-surface-variant': hsl(accent, 0.18, 0.30),
            '--outline': hsl(accent, 0.14, 0.48),
            '--outline-variant': hsl(accent, 0.22, 0.82),
            '--inverse-surface': hsl(accent, 0.20, 0.18),
            '--inverse-on-surface': hsl(accent, 0.10, 0.93),
            '--warning': WARNING_LIGHT,
            '--scrim': 'rgba(20, 24, 29, 0.42)',
            '--score-paper': '#FFFFFF',
            '--score-ink': '#14181D'
        };
    }

    function prefersDark() {
        return !!(global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches);
    }

    function resolveDark(mode) {
        if (mode === 'Dark') return true;
        if (mode === 'Light') return false;
        return prefersDark();
    }

    function hueOf(palette) {
        var found = null;
        for (var i = 0; i < PALETTES.length; i++) {
            if (PALETTES[i].id === palette) { found = PALETTES[i]; break; }
        }
        if (!found || found.hue < 0) return 212;
        return found.hue;
    }

    function applyTheme(mode, palette) {
        var dark = resolveDark(mode);
        var hue = hueOf(palette);
        var scheme = tonalScheme(hue, dark);
        var root = global.document.documentElement;

        for (var key in scheme) {
            if (Object.prototype.hasOwnProperty.call(scheme, key)) {
                root.style.setProperty(key, scheme[key]);
            }
        }
        root.dataset.theme = dark ? 'dark' : 'light';
        root.style.colorScheme = dark ? 'dark' : 'light';

        /* 谱面纸色跟着主题走，深色下不再是刺眼的白纸。 */
        var surfaceLuminance = relativeLuminance(hue, dark ? 0.14 : 0.45, dark ? 0.08 : 0.99);
        root.style.setProperty('--score-paper', dark ? '#F7F8FA' : '#FFFFFF');
        root.style.setProperty('--score-paper-luminance', String(round(surfaceLuminance, 3)));

        var meta = global.document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', scheme['--surface']);
        return { dark: dark, hue: hue };
    }

    /* ------------------------------------------------------------------ */
    /* 设备 / 方向监听                                                       */
    /* ------------------------------------------------------------------ */

    function currentDevice() {
        var nav = global.navigator || {};
        return detectDevice(nav.userAgent, nav.platform, nav.maxTouchPoints);
    }

    /*
     * 布局该用横版还是竖版，取决于视口本身，而不是设备物理朝向：
     * 桌面端拉窄窗口、平板分屏、内嵌 WebView 里，screen.orientation 都会和
     * 真实视口不一致，跟着它走会出现“竖着却套横版排版”。
     */
    function currentOrientation() {
        var width = global.innerWidth || 0;
        var height = global.innerHeight || 0;
        if (width > 0 && height > 0 && width !== height) {
            return width > height ? 'landscape' : 'portrait';
        }
        var type = global.screen && global.screen.orientation && global.screen.orientation.type;
        if (type) return type.indexOf('landscape') === 0 ? 'landscape' : 'portrait';
        return 'landscape';
    }

    function applyDeviceAttributes() {
        var root = global.document.documentElement;
        var device = currentDevice();
        var orientation = currentOrientation();
        var nav = global.navigator || {};

        root.dataset.device = device;
        root.dataset.orientation = orientation;
        root.dataset.platform = detectPlatformLabel(nav.userAgent, device);
        root.dataset.touch = (nav.maxTouchPoints > 0 || 'ontouchstart' in global) ? 'true' : 'false';
        return { device: device, orientation: orientation };
    }

    function watchEnvironment(onChange) {
        var last = applyDeviceAttributes();

        function refresh() {
            var next = applyDeviceAttributes();
            if (next.device !== last.device || next.orientation !== last.orientation) {
                last = next;
                onChange(next);
            }
        }

        global.addEventListener('resize', refresh);
        global.addEventListener('orientationchange', refresh);
        if (global.screen && global.screen.orientation && global.screen.orientation.addEventListener) {
            global.screen.orientation.addEventListener('change', refresh);
        }
        if (global.matchMedia) {
            var query = global.matchMedia('(prefers-color-scheme: dark)');
            var listener = function () { onChange(last); };
            if (query.addEventListener) query.addEventListener('change', listener);
            else if (query.addListener) query.addListener(listener);
        }
        return refresh;
    }

    global.PianoPlatform = {
        Settings: Settings,
        THEME_MODES: THEME_MODES,
        PALETTES: PALETTES,
        DEVICE_PHONE: DEVICE_PHONE,
        DEVICE_TABLET: DEVICE_TABLET,
        DEVICE_DESKTOP: DEVICE_DESKTOP,
        detectDevice: detectDevice,
        currentDevice: currentDevice,
        currentOrientation: currentOrientation,
        applyDeviceAttributes: applyDeviceAttributes,
        watchEnvironment: watchEnvironment,
        applyTheme: applyTheme,
        resolveDark: resolveDark,
        hueOf: hueOf,
        tonalScheme: tonalScheme
    };
})(window);
