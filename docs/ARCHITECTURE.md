# Web 1.0 架构

沿用静态托管、IndexedDB 曲库、PDF/照片及校音模块；重建音符输入与跟谱核心。

- assets/scoreviewer/{graph,numbered,navigation}.js 与 Android 1.0 共用；viewer.js 只适配相对资源路径和 web-bridge。
- js/core/tempo-pitch.js：Kotlin SLT_OLTW 的 float32 递推；1631 个起音与 Android 路径逐项比对。
- js/core/score-follower.js：多候选定位、停顿后恢复、确认跳转、静音冻结与速度预测。
- js/core/piano-stream.js：同一模型，16 kHz 因果重采样，17920 样本过去窗口，每 2048 个新样本推理，输出 26..29 帧。
- js/analysis-worker.js：WASM 与对齐在 Worker；配置、输入来源、会话代次隔离；旧帧不能覆盖新起点。
- js/audio.js：AudioWorklet 采集，采样率来自 AudioContext；取消的权限申请和旧资源收尾不能关闭新输入。
- js/web-midi.js：Web MIDI 端口、琴键和踏板状态、录制；js/core/midi-recording.js 生成原始时间的 SMF。
- js/core/assessment.js：只读取实际起音，期望音和预测位置不能直接得分；基础评分实现独立于安卓。
- js/library.js：原 IndexedDB 库兼容保存，新增原始 Blob 和练习 tick 字段。

window.AndroidHost 仅为 iframe 到主页面的结构化桥接适配；消息验证同源与父窗口。
Worker 的旧 DSP window 别名在导入 TFJS 前移除，避免运行时误判为 DOM 页面。
静态运行时全部自托管，TFJS 与 WASM 版本由 package-lock.json 固定。

翻页由共享渲染器独立负责，主页面不再运行第二个相互竞争的翻页算法。
实际确认事件与外推光标分开，低置信度与手动浏览暂停自动移动。
监听、示范、校音互斥；进入后台会停止麦克风。MIDI 原始事件不等于派生的量化谱面。

## 输入准备与看谱界面修正

ListeningEngine.prepareModel 先建立 AudioContext 和 Worker、显示模型下载进度，modelReady 后再调用 getUserMedia。首次录音不再消耗在模型下载期间；准备可取消，三分钟超时。请求序号与代次防止取消后迟到的权限结果改写新会话。

跟谱面板统一通过 openMicPanel 管理 inert、焦点、遮罩和 aria 状态，层级高于顶栏。关闭、Esc、遮罩共用一个收起路径；收起不停止采集。
默认折叠播放栏，次要看谱操作进入“更多”；跟谱入口从谱面边缘移入工具栏。SVG 按原比例排版，小屏只调整等比缩放和标题字号，旋转重新排版。
