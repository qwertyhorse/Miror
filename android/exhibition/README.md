# OpenBuy 展会试衣镜 Android

应用版本 **0.6.0 / versionCode 15**，包名 `ai.openbuy.exhibition`。启动时自动选择设备支持的镜端：WebView 111 及以上打开最新 V1.1 网页；旧 WebView 自动进入原生 XMAX 镜端。旧设备可选择由 Linux 或安卓本机识别手势，主视频始终通过安卓原生 RTC 直接连接 XMAX。

## 安装使用

1. 安装 `OpenBuy-展会试衣镜-0.6.0.apk`，允许摄像头权限。需要 Android 9 或更新版本；WebView 74 设备自动使用原生兼容入口，无需升级系统 WebView。旧入口支持 XMAX；Decart 仍需 WebView 111 及以上。
2. 首次显示四位绑定码，在 V1.1 工作人员后台绑定对应智能镜。同签名覆盖升级沿用原来的安装身份与绑定；不同构建机的 debug 签名不能直接覆盖旧包。
3. 在后台配置该镜的供应商密钥与素材，点击“开始体验”才启动生成。永久密钥不写入 APK。

默认镜端为 `https://xuxin.local:10202/v1.1/exhibition/screen`，后台为 `http://xuxin.local:10101/`。大屏和 Ubuntu 后台电脑须在同一局域网，云端生成还需互联网。新设备网页更新后重新连接即可；旧设备的原生代码和手势判断脚本随 APK 更新，服装与后台设置仍实时同步。

网页入口长按左下角“设备”、原生入口长按 Logo 可修改镜端网址。原生入口通过系统 DNS、局域网 NSD 服务和已有备用 IP 解析后台；Ubuntu 同时广播 `xuxin.local` 地址和 `Miror-xuxin` 服务，避免与原 Mac 冲突。默认地址迁移保留镜编号，自定义地址不变。HTTP 10101 与旧 HTTP 10200 镜端地址自动使用同主机 HTTPS 10202。

debug 包仅对指定局域网域名信任随包 CA 公钥，不跳过 TLS 或主机名验证。后台重建 CA 后需重新打包。直接使用 IP 地址时，证书仍须包含该地址，且设备需信任对应 CA。

## 两台旧设备对比

在原生入口长按 Logo，使用现有设备设置中的“手势识别”选择 **Linux 电脑**（默认）或 **安卓本机**。选择会保存在本机，设备绑定不变。应先停止体验再切换模式，分别在两台设备上用相同摄像头、位置、光照与手势参数比较。

| 模式 | 识别位置 | 额外局域网传输 | 主要验收点 |
| --- | --- | --- | --- |
| Linux 电脑 | Ubuntu 上每设备独立的 MediaPipe CPU 进程及 V1.1 检测器 | 摄像头抽样 JPEG，长边最多 480 像素、质量 70、每帧最多 256 KiB | 两台同时使用时的网络时延、丢帧、断线与恢复 |
| 安卓本机 | 安卓原生 MediaPipe 手部模型，离线执行 APK 内的 V1.1 检测器 | 无手势画面上传 | 旧安卓 CPU 的速度、发热及主视频是否受影响 |

两种模式均复用 RTC 捕获的画面，不占用第二路摄像头。主视频、云端生成画面和音视频连接均不经过 Linux 转发。Linux 手势帧仅在内存中处理，不保存画面；每台设备最多一帧在途，后来的繁忙帧直接丢弃，不补发。新连接或重试后先收手，避免仍举着的手被当成新动作。

Linux 侧需先按 [运行时说明](../../runtime/gesture/README.txt) 安装隔离 Python 环境，然后沿用 `miror-preview.service` 启动服务。默认最多两路识别会话。安装依赖不修改系统 Python，也不需要 XMAX 密钥。Linux 模式故障时显示简短的手势重试入口，手动选衣仍可用；不会暗中切换模式而影响对比结论。

## 最新镜端行为

- 持续展掌只换一次，收手后再抬手才能再次触发。
- 命令提交、素材准备、连接与服务端生成期间丢弃手势，不排队、不补执行；有效收手仍用于解除手势锁定。
- 点击选衣、翻页笔方向键和后台选衣仍可使用；手势忙碌拦截不会取消手动操作。原生 SDK 条件更新保持串行。
- 收到服务端切换确认后恢复手势；SDK 没有逐套服装画面完成信号，实际画面可能稍后更新。
- 两种入口均保留摄像头选择、后台远程检测、素材抽屉与皮肤。旧设备从 RTC 已捕获的画面抽样，不另开第二路摄像头；最多检测两只手，使用共享检测器的单手归属规则。原生兼容入口不运行身体姿态模型。
- 安卓本机推理最多 10 帧/秒、输入长边最多 640 像素；Linux 上传长边最多 480 像素。繁忙帧和超过 800ms 的迟到结果直接丢弃。USB 摄像头枚举及实际推理速度仍需在具体大屏验收。
- 原生安装身份通过同源接口提供给镜端，网页不持有永久供应商密钥。设备自启动、系统 kiosk 和 USB 驱动由大屏系统配置。
- 原生端与网页端共用已发布素材与 `binding-v1` 协议：复用后台持久化的素材绑定，未就绪时不在镜端补上传，也不提前申请临时凭证。缺少发布协议的旧后台会提示更新，不回退到 SDK 上传或镜端缓存。MoX 仅下载本地原图作为输入画面。
- 续接先取得后台计划，再释放旧 RTC 和确认旧凭证停止，最后提交续接。取得计划前的临时网络错误或素材切换冲突保留当前画面，在后续心跳重试；租约与凭证硬到期仍独立约束连接。

## 构建与验证

需要 JDK 17、Android SDK 37.0、build-tools 36.0.0。项目使用 AGP 9.1.1、Gradle 9.3.1，minSdk 28、targetSdk 35。

```sh
# 在仓库根目录，使用项目 Node.js 运行时生成并核对共享手势脚本
node scripts/build-android-gesture.mjs
node scripts/build-android-gesture.mjs --check
cd android/exhibition
sh scripts/build-local.sh assembleDebug lintDebug --max-workers=2
sh scripts/test-native.sh
```

`build-local.sh` 仅为当前进程设置工具链路径，不改全局 shell，不自动接受许可。默认兼容 Mac 工具链与 Ubuntu 的 `~/.local/share/openbuy-android/{jdk-17,sdk}`，也可设置 `JAVA_HOME`、`ANDROID_HOME`、`GRADLE_USER_HOME`。

输出 `app/build/outputs/apk/debug/app-debug.apk`。debug 签名由构建机的本地 keystore 决定；覆盖旧包需要相同签名。正式发布需另行配置长期签名，不应卸载已有绑定的包来绕过签名不匹配。

原生 JVM 测试使用隔离网络与供应商替身，不消耗真实额度，覆盖原生流程、上传所有权、帧过期、迟到结果和 NSD。网页手势集成测试使用真实检测器、Hook 和 Kiosk，仅模拟摄像头推理和网络。`tests/nativeGestureRuntime.test.ts` 同时校验 APK 内脚本与当前 TypeScript 源码完全一致；旧 Chromium 和 Android 的验证见 [手势运行时](docs/native-gesture-runtime.md)。服务端协调器、HTTP 边界和真实模型分别有隔离测试，模型性能结果不包含安卓编码与局域网往返时间。实际两台 ARM 大屏摄像头与云端画面仍须实机验收。

`uiPreview` 仅用于静态界面截图，包名后缀 `.uipreview`，不作为摄像头、手势或云端生成的验收结果。

## 保留的原生 SDK

官方来源：https://github.com/XingMai/XmaxSDK-Android ，固定 commit `14ed6e1327f82c58bb17ea93910d301caee80aea`。MIT 许可证保留在 `vendor/xmax-sdk/LICENSE`，`UPSTREAM.json` 记录源码和 JNI SHA-256。

SDK 源码调整国内/国际两个 API 根地址，并补充 RTC 摄像头枚举和按设备 ID 选择；具体差异见 `vendor/xmax-sdk/LOCAL_CHANGES.md`。JNI 来自官方 Maven 1.0.8 AAR，包含 arm64-v8a、armeabi-v7a、x86、x86_64。未使用原 APK 的反编译代码或签名。

当前官方 `libxmax_yuv.so` 未做 16KB 页对齐，16KB 页 Android 设备需重编该库后验证。SDK 未透传所有摄像头热拔异常；外接 USB 摄像头取决于大屏系统和 RTC 支持，必须实机测试。尚未用真实凭证验证云端生成和弱网效果。

Android 9 / WebView 69 模拟器可验证离线手势脚本与原生界面边界，但官方 RTC 所需的 `libbytenn.so` 没有 x86_64 版本，不能用该模拟器完成真实摄像头 RTC 验收；这项限制不等同于 ARM 大屏的运行结果。
