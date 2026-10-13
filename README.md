# OpenBuy 展会智能镜 · 2026-10-13

独立的 V1.1 镜端、工作人员后台和 Node API，包含 99 个展会预设素材及本地挥手识别模型。前端与 API 由同一入口提供。

## 启动

安装 Node.js 22.13 或更新版本（建议 24），本地交付 ZIP 已包含 dist；从 GitHub 获取源码时，先执行 npm ci 和 npm run build。解压整个目录后执行：

```sh
npm ci --omit=dev
npm run setup
npm start
```

`setup` 只在缺少时创建环境文件与素材库，并生成本机 HTTPS 证书；重复执行保留已有配置与素材。`npm start` 同时启动前端、API、HTTP 和 HTTPS。窗口需保持运行，按 Ctrl+C 停止。

- 工作人员后台：[http://xuminghong.local:10601/](http://xuminghong.local:10601/)
- 本地入口：[http://xuminghong.local:10200/](http://xuminghong.local:10200/)
- 镜端：[http://xuminghong.local:10200/v1.1/exhibition/screen](http://xuminghong.local:10200/v1.1/exhibition/screen)，自动进入 HTTPS 10202 摄像头页面。

macOS 可双击 `启动展会局域网.command`。脚本会自动查找已安装的 Node（包括 Codex 本机运行时），需要安装带 npm 的 Node.js。首次自动安装依赖、初始化并启用后台托管，关闭窗口、锁屏或熄屏后继续运行；重启后登录自动恢复。后台运行文件与持久数据保存在 `~/Library/Application Support/Miror/preview/<目录标识>/`，不依赖后台进程读取“桌面”或“文稿”。双击 `停止局域网预览.command` 停止本包服务并解除防眠。主动睡眠、合盖、退出登录、关机或断网会影响访问。

Windows 可双击 `启动展会.cmd`。首次安装需联网；其他电脑需要能解析 `xuminghong.local`，或使用后台输出的局域网 IP 备用地址。设备与服务电脑应在同一局域网，防火墙需允许 HTTP 10200/10201/10601 和 HTTPS 10202。

## 摄像头与 XMAX

首次在镜端设备上安装并信任本包生成的 `.data/lan-tls/root-ca.crt`，也可从后台下载公开 CA。初始化不会修改系统信任。

在后台当前设备设置区的 HTTPS 表单中配置每台镜的 XMAX SK 和区域。HTTP 页面只接收保存结果，不接收密钥。也可在服务端 `.env` 配置默认 `XMAX_API_KEY`。密钥、会话记录和证书私钥仅保存在运行电脑。前台运行数据在包内 `.data`；macOS 后台托管的数据在上述运行目录的 `data/`，环境文件为 `app/.env`。搬迁已有运行数据时需同时保留数据目录中的加密密钥，不能只搬数据库。

素材库首次以演示模式初始化。配置 SK 后在后台选择实时模式；镜端仅准备本地取景，点击“开始体验”才启动生成。临时凭证有单次限制和有效期；不设置本地累计预算，额度不足以 XMAX 返回为准。

## 技术接手

- `src/`：独立智能镜和后台界面。
- `server/`：多镜、素材、设备、凭证和实时会话 API。
- `shared/`：前后端共享类型与命令协议。
- `dist/`：可直接运行的前端构建；改源码后需重新构建。
- `seed/`：99 个预设素材及 SHA256 清单，不包含设备绑定和历史会话。
- `scripts/`：初始化、静态服务、HTTP/HTTPS 网关和 macOS 后台托管。
- [docs/API.md](docs/API.md)：接口、请求示例与完整实时会话流程。

外部接口前缀是 `/v1.1/api/exhibition`；前端使用同源相对地址，网关将其代理到内部 API 的 `/api/exhibition`。**不要只上传 `dist` 到普通静态空间**；后台 API 与 HTTPS 网关也必须一起运行。`dist/index.html` 需要由服务打开，不支持双击文件预览。

内部 API 3002 与静态服务 5173 仅监听本机；前台启动和 macOS 托管均使用同一组固定端口。端口被其他工程占用时会明确报错，不停止占用程序。本机正在运行原工程时，独立包不能同时占用同一组入口。

启动环境检查（不安装依赖、不启动服务）：

```sh
bash scripts/launch-mac.sh doctor
```

修改后验证：

```sh
npm ci
npm run build
npm test
npm run test:runtime
npm run test:package
```

普通界面开发可用 `npm run dev`；完整局域网与摄像头流程使用 `npm start` 或 macOS `npm run lan:start`。停止后台服务后重新启动会同步源码与依赖，已有后台数据与环境配置保留。运行数据与本机依赖不进入交付压缩包，应在目标系统重新安装依赖。本包不包含主站、V1.0、生产密钥或现场运行记录，未配置自动发布。

## 本次技术交接

本次交付以当前 V1.1 展会源码为准，包含挥手切换素材、同一实时会话内换装，以及云端失败后的本地取景与重试。详见 `技术交接说明.txt`；本次构建、测试和校验记录见 `docs/verification.json`。

Ubuntu 可使用上述 Node 前台启动流程；Linux 的 systemd 开机自启、进程守护、防闲置睡眠与 Avahi 域名广播需由技术补充，本次未进行 Ubuntu 实机验收。挥手识别在浏览器本地 Worker 中复用当前摄像头，不上传识别帧；模型与 WASM 随源码提供。现场摄像头、光线和距离仍需实机联调。

本次验证结果见 `docs/verification-20261013.json`。验证使用模拟供应商，XMAX 调用为 0；此前交付的生产依赖安装验收保留在 `docs/verification.json`。

## 手掌识别与后台参数

后台“控制与设置 → 设备设置 → 手势识别”可多选手掌识别、左右挥手，默认仅启用手掌。五指自然并拢也可识别，默认确认时间 300 ms；持续举掌只切换一次。全部取消勾选即可关闭。每台镜子独立保存，修改后点击“保存识别设置”，恢复默认也需保存。

“识别参数”提供 MediaPipe 手检测/存在置信度、框跟踪阈值、手掌确认时间、收手间隔、帧率上限和输入分辨率。网页采用浏览器摄像头与 Canvas 取帧，没有 OpenCV 运行时。完整范围和请求格式见 [API 文档](docs/API.md)。后台仅在体验结束、实时会话停止后允许保存。

镜端 URL 加 `diagnostics=1` 打开诊断，支持导出和清空。记录仅在页面内存中保留最多 10,000 条，不包含密钥、图像和原始关键点。“已看到新衣服”是人工观察值，SDK 提交成功和会话首帧不能替代逐套服装确认。现场识别准确率、重复率及生成画面仍需真人验收。

本轮源码与测试结果见 [手势设置验收](docs/verification-gesture-settings-20261013.json)。可选 Mac 浏览器回归脚本为 `scripts/check-exhibition-gestures.mjs` 和 `scripts/check-exhibition-gesture-settings.mjs`，需先安装 `@playwright/test` 并有 Google Chrome；构建后使用 `GESTURE_CHECK_DIST="$PWD/dist" node scripts/check-exhibition-gesture-settings.mjs`。脚本使用假摄像头和隔离 API，不启动真实 XMAX。
