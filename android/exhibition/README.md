# OpenBuy 展会试衣镜 Android

应用版本 **0.5.0 / versionCode 13**，包名 `ai.openbuy.exhibition`。启动入口为 `MainActivity`，使用 Android System WebView 打开最新 V1.1 镜端；XMAX 与 Decart 均沿用网页镜端的摄像头、手势、翻页笔和换装逻辑。原生 XMAX Activity 与 SDK 保留为非导出内部实现。

## 安装使用

1. 安装 `OpenBuy-展会试衣镜-0.5.0.apk`，允许摄像头权限。需要 Android 9 或更新版本，以及 System WebView 111 或更新版本。
2. 首次显示四位绑定码，在 V1.1 工作人员后台绑定对应智能镜。同签名覆盖升级沿用原来的安装身份与绑定；不同构建机的 debug 签名不能直接覆盖旧包。
3. 在后台配置该镜的供应商密钥与素材，点击“开始体验”才启动生成。永久密钥不写入 APK。

默认镜端为 `https://xuxin.local:10202/v1.1/exhibition/screen`，后台为 `http://xuxin.local:10101/`。大屏和 Ubuntu 后台电脑须在同一局域网，云端生成还需互联网。APK 加载运行中的网页，不内置网页构建；网页更新后重新连接即可使用最新版本。

长按左下角“设备”可修改镜端网址。默认域名使用系统 DNS / mDNS 解析；WebView 不使用保留原生入口中的 NSD 或备用 IP。默认地址迁移保留镜编号，自定义地址不变。HTTP 10101 与旧 HTTP 10200 镜端地址自动使用同主机 HTTPS 10202。

debug 包仅对指定局域网域名信任随包 CA 公钥，不跳过 TLS 或主机名验证。后台重建 CA 后需重新打包。直接使用 IP 地址时，证书仍须包含该地址，且设备需信任对应 CA。

## 最新镜端行为

- 持续展掌只换一次，收手后再抬手才能再次触发。
- 命令提交、素材准备、连接与服务端生成期间丢弃手势，不排队、不补执行；有效收手仍用于解除手势锁定。
- 点击选衣、翻页笔和后台选衣沿用网页现有行为。
- 收到服务端切换确认后恢复手势；SDK 没有逐套服装画面完成信号，实际画面可能稍后更新。
- 摄像头选择、后台远程检测、素材抽屉与皮肤均由最新 V1.1 网页提供。USB 摄像头能否枚举取决于大屏系统和 WebView，需实机验收。
- 原生安装身份通过同源接口提供给镜端，网页不持有永久供应商密钥。设备自启动、系统 kiosk 和 USB 驱动由大屏系统配置。

## 构建与验证

需要 JDK 17、Android SDK 37.0、build-tools 36.0.0。项目使用 AGP 9.1.1、Gradle 9.3.1，minSdk 28、targetSdk 35。

```sh
cd android/exhibition
sh scripts/build-local.sh assembleDebug lintDebug --max-workers=2
sh scripts/test-native.sh
```

`build-local.sh` 仅为当前进程设置工具链路径，不改全局 shell，不自动接受许可。默认兼容 Mac 工具链与 Ubuntu 的 `~/.local/share/openbuy-android/{jdk-17,sdk}`，也可设置 `JAVA_HOME`、`ANDROID_HOME`、`GRADLE_USER_HOME`。

输出 `app/build/outputs/apk/debug/app-debug.apk`。debug 签名由构建机的本地 keystore 决定；覆盖旧包需要相同签名。正式发布需另行配置长期签名，不应卸载已有绑定的包来绕过签名不匹配。

原生 JVM 测试使用隔离网络与供应商替身，不消耗真实额度，继续覆盖保留的原生代码和共享 URL 策略。网页手势集成测试使用真实检测器、Hook 和 Kiosk，仅模拟摄像头推理和网络。实际安卓摄像头与云端画面仍须在大屏验收。

`uiPreview` 构建仍用于保留的原生界面截图，包名后缀 `.uipreview`，不作为本版本 WebView 主入口的验收结果。

## 保留的原生 SDK

官方来源：https://github.com/XingMai/XmaxSDK-Android ，固定 commit `14ed6e1327f82c58bb17ea93910d301caee80aea`。MIT 许可证保留在 `vendor/xmax-sdk/LICENSE`，`UPSTREAM.json` 记录源码和 JNI SHA-256。

SDK 源码调整国内/国际两个 API 根地址，并补充 RTC 摄像头枚举和按设备 ID 选择；具体差异见 `vendor/xmax-sdk/LOCAL_CHANGES.md`。JNI 来自官方 Maven 1.0.8 AAR，包含 arm64-v8a、armeabi-v7a、x86、x86_64。未使用原 APK 的反编译代码或签名。

当前官方 `libxmax_yuv.so` 未做 16KB 页对齐，16KB 页 Android 设备需重编该库后验证。SDK 未透传所有摄像头热拔异常；外接 USB 摄像头取决于大屏系统和 RTC 支持，必须实机测试。尚未用真实凭证验证云端生成和弱网效果。
