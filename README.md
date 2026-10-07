# 智能曲谱 · 网页端

[智能曲谱](https://github.com/Jimmy-xuzimo/PianoScoreFollower)（Android 端）的网页版本：
**功能完全对齐，一份静态站点跑在手机、平板和电脑上**。
导入 MIDI / MusicXML / PDF / 照片乐谱，用麦克风听你弹钢琴，自动定位光标、自动翻页；
需要时切到滚动谱匀速滚动。

网页端与手机端共用同一套算法与视觉：DSP、跟谱、校音是从 Kotlin 逐行移植过来的，
配色是从 `ui/Theme.kt` 的色调生成算法复刻的，乐谱排版直接复用手机端 WebView 里那份
alphaTab 渲染器。

> 本仓库只包含网页端，与 Android 仓库相互独立。Android 端见
> [PianoScoreFollower](https://github.com/Jimmy-xuzimo/PianoScoreFollower)。

---

## 快速开始

网页端是**纯静态站点**，但必须通过 HTTP 打开，不能双击 `index.html`：

| 原因 | 说明 |
| --- | --- |
| AudioWorklet | `audioWorklet.addModule()` 只在安全上下文可用，`file://` 会被拒绝 |
| 麦克风 | `getUserMedia` 同样要求安全上下文 |
| 资源加载 | 乐谱、字体、SoundFont 都靠 fetch/XHR，`file://` 下会被 CORS 拦掉 |

`localhost` 算安全上下文，所以本机调试只要跑一下自带的启动脚本：

```bash
python serve.py                     # 默认 http://127.0.0.1:8765/
python serve.py --port 9000         # 换端口
python serve.py --host 0.0.0.0      # 让局域网内的手机 / 平板也能访问
```

脚本会补上 Python 默认 MIME 表里没有的类型（`.sf2`、`.woff2`、`.musicxml`、`.mid`…），
并在开发期关掉缓存——否则改完 js/css 浏览器还在跑旧版本，很容易误判成「没生效」。

用 `--host 0.0.0.0` 时终端会打印局域网地址，手机连同一个 Wi-Fi 打开即可。
注意：**非 localhost 的 HTTP 页面拿不到麦克风**，手机实机测跟谱必须用 HTTPS。

---

## 部署

任意静态托管都行（Nginx / Caddy / GitHub Pages / Cloudflare Pages / 对象存储 + CDN）。
两个硬性要求：

1. **必须 HTTPS**。麦克风与 AudioWorklet 都要求安全上下文，这是浏览器的硬限制。
2. **`index.html` 必须由服务器直接返回**，不能被改写路由。页面内所有资源引用都是
   相对路径，所以站点放在域名根（`https://example.com/`）或任意子路径
   （`https://example.com/piano/`、GitHub Pages 的 `https://user.github.io/repo/`）
   都能正常工作，无需改任何配置。

Nginx 参考配置：

```nginx
server {
    listen 443 ssl http2;
    server_name example.com;

    root /srv/piano-web;          # 即本目录的内容
    index index.html;

    # 大型二进制资源：SoundFont 与 alphaTab 运行时，开长缓存
    location ~* \.(sf2|woff2|otf|woff)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # 代码与页面：短缓存，发版后能及时更新
    location ~* \.(js|css|html)$ {
        expires 1h;
        add_header Cache-Control "public";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

需要确保服务器给 `.sf2` 返回 `application/octet-stream`（或任意二进制类型），
给 `.js` 返回 `text/javascript`——类型不对会导致 alphaTab 拒绝解析音源、
或模块脚本被浏览器按严格模式拒绝执行。

---

## 功能对照

网页端与 Android 端逐项对齐，没有缺失项：

| 功能 | 说明 | 手机端 | 网页端 |
| --- | --- | :---: | :---: |
| MIDI / MusicXML 导入 | 自研 MIDI → MusicXML 转换后交给 alphaTab 排版 | ✅ | ✅ |
| PDF 导入 | 逐页光栅化为 JPEG，进滚动谱 | ✅ | ✅ |
| 照片导入 | 相册多选（最多 60 张）或文件多选 | ✅ | ✅ |
| 乐谱库持久化 | 重启不丢失，可逐条删除 | ✅ | ✅（IndexedDB） |
| 播放乐谱 | 播放 / 暂停 / 停止，点谱面定位 | ✅ | ✅ |
| 滚动谱 | 设定总时长匀速滚动，可暂停、手动调速 | ✅ | ✅ |
| 实时跟谱 | 麦克风采集 + FFT 音高检测，A0–C8 全 88 键 | ✅ | ✅ |
| 逐行跟随 | 当前谱行滑出舒适区才重新锚定 | ✅ | ✅ |
| 自动翻页 | 置信度模型驱动 | ✅ | ✅ |
| 跟谱面板 | 左边缘半透明小箭头唤出，含电平表、音级、匹配度 | ✅ | ✅ |
| 校音 | 先校准中央 C，再显示音名与音分偏差 | ✅ | ✅ |
| 音高环 | 十二音级指示 + 中央 C 校准进度 | ✅ | ✅ |
| 深浅模式 | 跟随系统 / 浅色 / 深色 | ✅ | ✅ |
| 界面颜色 | 跟随壁纸 + 经典蓝 / 典雅紫 / 松石绿 / 暖琥珀 / 玫瑰粉 | ✅ | ✅ |
| 偏好持久化 | 主题、总时长、上次打开的乐谱 | ✅ | ✅（localStorage） |

网页端额外补了几处只在桌面端才成立的交互：拖拽文件导入、`空格` 播放/暂停、
`←` `→` 翻页。这些不影响手机端行为。

---

## 设备适配

### 形态识别走 UA，布局走视口

`html[data-device]` 由 UA 判定，只取 `phone` / `tablet` / `desktop` 三态；
`html[data-orientation]` 由**视口宽高**判定，而不是 `screen.orientation`。
分开处理是有原因的：

- **iPad 从 iPadOS 13 起把自己报成 `Macintosh`**，只看 UA 会误判成桌面；
  所以补了一条判据：`platform === 'MacIntel' && maxTouchPoints > 1` 判为平板。
- **Android 平板与手机的差别只在 UA 里有没有 `Mobile`**。
- 方向如果跟着 `screen.orientation` 走，在桌面端拉窄窗口、平板分屏、内嵌 WebView
  里都会和真实视口不一致，出现「竖着却套横版排版」。所以方向优先由
  `innerWidth / innerHeight` 决定，只有视口是正方形时才回退到 `screen.orientation`。

判定结果写在 `<html>` 上，CSS 直接按属性选选择器，同时保留媒体查询作为兜底
（禁用 JS 或 UA 被伪装时仍然可用）。

### 横竖屏与各尺寸的取舍

- **手机竖屏**：底部控制条只留核心控件，`回到开头` 与 `自动翻页` 收进顶栏的
  「更多操作」菜单，功能不丢但一行放得下，不会横向溢出。
- **手机横屏 / 平板**：控制条完整展开，跟谱面板以常驻侧栏形式贴在左边缘。
- **桌面**：跟谱面板默认展开为固定侧栏，谱面区居中，支持拖拽导入。
- 底部悬浮控制条固定高 64px、最大宽 620px，可下滑隐藏、由底部小把手唤出——
  与手机端同一套几何参数。

已用 Chrome DevTools Protocol 模拟 iPhone、iPad、Android 手机与桌面，
逐一验证 `data-device` / `data-orientation` 取值、横向溢出与控件宽度，全部通过。

---

## 麦克风识别与跟谱算法

这一块是与手机端**逐行对齐**移植的，不是另写一套：

- **采样率用设备实际值**。固定按 44.1 kHz 假设会让 48 kHz 设备上的音高整体偏高
  约 1.5 个半音，表现为「弹了没反应」。网页端从 `AudioContext.sampleRate` 读真实值。
- **8192 点 FFT + 低频加权**，提升低音区精度；音高检测范围 27 Hz–4200 Hz，
  覆盖 A0–C8 全 88 键。
- **基频计两次权**（`FUNDAMENTAL_WEIGHT`）。否则 f、f/2、f/3… 的谐波积谱完全并列，
  「从低往高、严格大于」的扫描会把纯音判成它自己的低八度。
- **子谐波校正要验能量**。只有分频点本身真有能量时才回退，纯音不会被错误拉低八度。
- **起音检测延迟半个分析窗**（8192 点约 93 ms），让分析窗正好居中在触键瞬间。
- **匹配用余弦相似度与音级覆盖度等权融合**，单一音符在和弦里也能被认出来。
- **重复和弦要消费事件**。连续弹同一个和弦时，若只做「找最像的」，游标会永远停在
  第一个事件上；网页端跟踪已匹配事件下标，下一次起音从下一个事件开始找。
- **均值相减做对比度增强**，滤掉宽带噪声底，提高正确匹配分数。

音频采集与算法全部跑在 **AudioWorklet + Web Worker** 上，不占主线程——
主线程卡顿时不会掉帧，也不会漏音。

---

## 目录结构

```
.
├── index.html              页面骨架 + 内联 SVG 图标集
├── serve.py                本地静态服务器（正确 MIME + 开发期禁缓存）
├── css/
│   └── app.css             全部样式；颜色只走 :root 上的语义变量
├── js/
│   ├── platform.js         设备/方向识别、主题与配色、偏好持久化
│   ├── library.js          乐谱库：IndexedDB 读写、删除、统计
│   ├── importers.js        导入分流：MIDI / MusicXML / PDF 光栅化 / 图片
│   ├── midi.js             MIDI 解析 → MusicXML 生成
│   ├── dsp.js              FFT、色度提取、起音检测、音高检测
│   ├── follower.js         ScoreTimeline / ScoreFollower / PageTurnController
│   ├── calibration.js      校音引擎：中央 C 校准与音分偏差
│   ├── audio.js            麦克风采集管线（AudioWorklet 优先，ScriptProcessor 兜底）
│   ├── pcm-worklet.js      AudioWorkletProcessor：对齐 1024 帧整 hop
│   ├── analysis-worker.js  Web Worker：DSP + 跟谱 + 校音
│   └── app.js              主控：乐谱库、导入、播放、跟谱、校音、设置
└── assets/
    ├── scoreviewer/        alphaTab 乐谱渲染器（与手机端同一份，postMessage 通信）
    ├── alphatab/           alphaTab 运行时、Bravura 字体、SoundFont
    ├── pdfjs/              pdf.js（PDF 逐页光栅化）
    └── samples/            内置示例乐谱
```

模块都以 `window.PianoXxx` 挂出（`PianoDsp` / `PianoFollower` / `PianoCalibration` /
`PianoMidi` / `PianoImport` / `PianoLibrary` / `PianoPlatform` / `PianoAudio`），
方便单独测试，也便于 Worker 里 `importScripts` 复用同一份实现。

---

## 浏览器兼容

| 浏览器 | 支持情况 |
| --- | --- |
| Chrome / Edge 88+ | 完整支持（AudioWorklet + Web Worker） |
| Safari 14.1+（含 iOS / iPadOS） | 完整支持 |
| Firefox 76+ | 完整支持 |
| 无 AudioWorklet 的旧浏览器 | 自动退回 `ScriptProcessor`，延迟略高但可用 |

麦克风在 iOS Safari 上需要用户手势触发——页面上的「开始跟谱」按钮本身就是手势，
所以不需要额外处理。

---

## 已知限制

- **必须 HTTPS**（localhost 除外），否则麦克风与 AudioWorklet 不可用。
- **音频上下文需要用户手势解锁**。浏览器策略要求首次交互后才能出声，页面已把
  「播放」和「开始跟谱」都做成手势入口。
- 首次加载需拉取 alphaTab 运行时、Bravura 字体与 SoundFont，建议开启长缓存。
- 麦克风识别依赖真实输入，**桌面端用外接麦克风、移动端用真机**才能得到可信结果；
  虚拟机、无声卡环境或纯静音输入下跟谱不会推进，这是预期行为。

---

## 许可证

与 Android 端主项目一致，[BSD 3-Clause](LICENSE) © 2026 Jimmy-xuzimo。

`assets/` 下的第三方资源遵循各自许可证（alphaTab：MPL 2.0；Bravura 字体：SIL OFL 1.1；
`piano.sf2`：CC0；pdf.js：Apache 2.0），再分发时请一并保留署名与许可证文本。