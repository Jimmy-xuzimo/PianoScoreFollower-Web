# 复现检查

## 通用检查

Node 22+、Python 3、本机 Chrome：

```sh
npm ci
npm test
npm run format:check
python serve.py --port 8767
node tools/responsive-smoke.cjs
node tools/ui-smoke.cjs
node tools/midi-smoke.cjs
```

CI 的 CI=true 使用已安装的 Playwright Chromium。本机默认使用 Chrome。
PSF_BASE_URL 可指向其他部署地址。所有浏览器测试使用临时独立配置，不修改用户浏览器数据。

## 模型与音频

node tools/probe-model.cjs 验证同站点 WASM 加载和 17920 → 4×[1,32,88] 输出。
35 秒音频对照使用 tools/stream-probe.html，需自行准备 tools/fixtures/audio.f32 与 expected.json。
音频为 44.1 kHz 单声道 float32，expected 为 [onsetMs,pitch] 数组；不随仓库分发。
node tools/microphone-smoke.cjs 使用 tools/fixtures/audio.wav 作为 Chrome 虚拟麦克风，覆盖真正的 AudioWorklet 与 Worker。
测试先预热模型下载（90 秒超时），再让虚拟录音开始，断言高置信度 FOLLOWING 帧；否则下载等待会消耗录音开头。
这些是测试输入，不能当作实体拾音已通过。

## 对齐回放

node tools/test-android-parity.cjs <Android case folder> 比较每个起音的 DP 路径。
node tools/evaluate-cached.cjs <manifest.txt> 顺序送入 NPF1 / NPF2 因果模型缓存，生成 web-trace.tsv。
python tools/report-web.py <manifest.txt> 读取独立真值，仅用于评价，不会反馈给算法。
每个目录需 graph.tsv、audio.f32、magenta-linear.notes.frames.bin、truth.tsv。
NPF1 旧中心标签减去 64 ms，NPF2 使用原帧标签；结果可用时间保持不变。

## 文件与回归

node tools/import-smoke.cjs 使用同级 device-fixtures 中的 study.mxl、psf-two-pages.pdf、broken.musicxml。
这些本机夹具不随生产部署分发。普通 npm test 不要求外部录音或模拟器。
虚拟 MIDI smoke 会接通模拟设备、跟随 8 个谱面事件、录制、结算、保存曲库并检查原始 Blob。
MIDI 互操作另用 mido 对照音高、力度、通道、踏板和时间，精度为一个 tick。
