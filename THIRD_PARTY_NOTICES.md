# 开源项目与资源署名

智能琴谱 Web 原创应用代码：Jimmy-xuzimo，BSD 3-Clause，见 LICENSE。
该软件协议不覆盖第三方实现、模型、字体、音源、音乐作品与测试录音。

| 项目 | 用途 | 协议 / 来源 |
| --- | --- | --- |
| Google Magenta Onsets and Frames | 与 Android 1.0 相同的实时单向钢琴模型 | Apache 2.0 · https://github.com/magenta/magenta |
| TensorFlow.js core / CPU 4.9.0 | 浏览器张量接口 | Apache 2.0 · https://github.com/tensorflow/tfjs |
| TensorFlow.js TFLite 0.0.1-alpha.10 | 本地 WebAssembly / XNNPACK 推理 | Apache 2.0 · https://github.com/tensorflow/tfjs/tree/master/tfjs-tflite |
| Parangonar SLT_OLTW | 从 Android Kotlin 适配移植的在线音高 / 速度对齐 | Apache 2.0 · https://github.com/sildater/parangonar |
| alphaTab 1.8.4 | 乐谱排版、播放与实际时间图谱 | MPL 2.0 · https://github.com/CoderLine/alphaTab |
| TinySoundFont / SFZero | alphaTab 内含合成组件 | MIT · https://github.com/schellingb/TinySoundFont · https://github.com/stevefolta/SFZero |
| Haxe Standard Library / SharpZipLib | alphaTab 内含 XML / 压缩组件 | MIT · https://github.com/HaxeFoundation/haxe · https://github.com/icsharpcode/SharpZipLib |
| NVorbis / libvorbis | alphaTab 内含解码组件 | MIT / BSD 3-Clause · https://github.com/NVorbis/NVorbis · https://github.com/xiph/vorbis |
| Bravura | 音乐符号字体 | SIL OFL 1.1 · https://github.com/steinbergmedia/bravura |
| FreePats Upright Piano KW (small) | 示范钢琴音源 piano.sf2 | CC0 1.0 · https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html |
| PDF.js | PDF 转换为滚动谱页 | Apache 2.0 · https://github.com/mozilla/pdf.js |
| Google Material Design icons | 界面 SVG 图标 | Apache 2.0 · https://github.com/google/material-design-icons |

完整 Apache、MPL、MIT、BSD、OFL、CC0 文本及资源署名随站点保存在 assets/licenses/。
alphaTab 内含组件的原始版权声明保留在 assets/alphatab/alphaTab.min.js 文件头。
TensorFlow.js 运行时与 WASM 文件按固定 npm 版本原样复制到 vendor/，保留其文件头声明。
重建命令：npm ci；npm run vendor。浏览器运行不依赖 npm 或外部 CDN。

Magenta 权重原样使用，SHA256：
272ebead546bcf342e56aaf3624ec5310c55de86d46aec48868720fad39d01ac。
来源及许可见 third_party/magenta/。WASM 单线程推理、流式重采样与 128 ms 滚动适配位于 js/core/piano-stream.js。
Parangonar 固定版本及算法来源见 third_party/parangonar/；JavaScript 适配位于 js/core/tempo-pitch.js。
Android 参照提交：4653d0375abad993de80d49b6184f137fe1af168。
上述项目不表示对本应用的认可或识别效果保证。

FreePats Upright Piano KW 由 Gonzalo、Roberto 于 2017 年录制，由 Roberto 编辑处理；
感谢 Inma Martínez de Miguel 和 Claudia Marín Martínez。未使用旧版闲置的 SONiVOX 音源。

《The Truth That You Leave／你离开的事实》为 Pianoboy 高至豪的音乐作品，
曲库保留原有示例，按需打开。音乐作品与曲谱版权归各自权利人，不适用软件 BSD 协议。

Matchmaker 外部 benchmark 仅用于本机评估，不随网站、源码或发布附件分发。
用户提供的真实视频和解码录音也不分发。评估数据许可与来源见
https://github.com/pymatchmaker/matchmaker-benchmark-data 。
