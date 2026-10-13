# OpenBuy 展会试衣镜 Android 原生版

应用版本 **0.2.1 / versionCode 4**，包名 `ai.openbuy.exhibition`。启动入口是原生 `NativeExhibitionActivity`，使用 XMAX 官方 Android SDK 1.0.8 和火山 RTC，不再依赖 Android System WebView 版本。旧 WebView Activity 仅保留为非导出内部类。

## 安装使用

1. 将 `OpenBuy-展会试衣镜-0.2.1.apk` 发送到大屏安装，允许摄像头权限。
2. 首次显示六位绑定码，在现有 V1.1 展会后台绑定到对应智能镜。升级旧包沿用原来的安装身份与绑定。
3. 在后台配置该镜的 XMAX 密钥、区域、额度及素材；选择素材后点击“开始体验”。永久密钥不写入 APK。

默认连接 `https://xuminghong.local:10202/v1.1/exhibition/screen` 对应的原生 API。设备须能访问 Mac 的局域网地址；XMAX 生成需要互联网。管理后台入口为 `http://xuminghong.local:10200/`。

右上角“设置”可更改展台网址和前/后置镜头。debug 包只对默认域名信任随包 CA 公钥，不跳过 TLS 或主机名验证。IP 的 HTTPS 地址仍须匹配证书。HTTP 10200 的旧镜端地址会规范化为同主机 HTTPS 10202。

## 应用行为

- 进入先准备本地摄像头并等待真实取景就绪，不申请临时 key，不创建云端生成任务。
- 素材、启用顺序、模式、后台切换和自动轮播同步现有 V1.1 状态。
- 支持 Free、CharX、ClothX、VibeX、DimX、MoX；MoX 使用素材图片和 SDK 触屏轨迹。Free 仅提示词素材不上传封面作为参考图。
- 开始时优先使用后台准备好的同账号、同区域参考图 URL；未准备或已失效时回退到下载和 SDK 上传。临时凭证只在开始体验时申请，绑定参考图和供应商 session 后开始生成。SDK 确认远端首帧后才报告成功，耗时从素材准备前开始计算。
- 同一体验内、同模式的摄像头换装复用临时凭证、RTC 和远端画面，串行更新条件。快速选择保留最新一套，取消过时的素材准备；上传失败保留当前画面，点状态可重试。Free 可以显式清空参考图；MoX 或模式变化重新建立会话。
- 后台状态通过最长 8 秒的变更等待请求同步，变化时立即返回；旧后台不支持时回退普通读取。
- 本地心跳每 5 秒发送，SDK 另有供应商心跳。有效期、连接错误、退出或模式切换时释放摄像头/RTC，并请求后台确认停止。未确认时显示重试入口，不自动申请下一份凭证。
- 同一代不会自动重复申请临时 key；停止可打断正在执行的开始操作，旧 revision 不能覆盖新状态。
- 前台保持屏幕常亮，退到后台停止采集。设备自启动、系统 kiosk 和 USB 驱动由大屏系统配置。

## 构建与验证

需要 JDK 17、Android SDK 37.0、build-tools 36.0.0。项目使用 AGP 9.1.1、Gradle 9.3.1，minSdk 28、targetSdk 35。

```sh
cd android/exhibition
sh scripts/build-local.sh assembleDebug lintDebug --max-workers=2
sh scripts/test-native.sh
```

`build-local.sh` 仅为当前进程设置工具链路径，不改全局 shell，不自动接受许可。使用本机代理时追加 `-Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=7897 -Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=7897`。

输出 `app/build/outputs/apk/debug/app-debug.apk`，debug 签名由构建机的本地 keystore 决定；覆盖旧包需要相同签名。正式发布需另行配置长期签名。

测试采用隔离 HTTP fixture 与假的供应商控制器，不访问真实后台或 XMAX、不消耗额度。覆盖 API 契约、会话 metadata、生成顺序及取消/清理。本轮执行范围与验收边界见 `../../docs/OPTIMIZATION.md`。

## SDK 来源与限制

官方来源：https://github.com/XingMai/XmaxSDK-Android ，固定 commit `14ed6e1327f82c58bb17ea93910d301caee80aea`。MIT 许可证保留在 `vendor/xmax-sdk/LICENSE`，`UPSTREAM.json` 记录源码和 JNI SHA-256。

SDK 源码仅调整国内/国际两个 API 根地址，以匹配现有后台签发和验证凭证的服务。JNI 来自官方 Maven 1.0.8 AAR，包含 arm64-v8a、armeabi-v7a、x86、x86_64。未使用原 APK 的反编译代码或签名。

当前官方 `libxmax_yuv.so` 未做 16KB 页对齐，16KB 页 Android 设备需重编该库后验证。SDK 未透传所有摄像头热拔异常；外接 USB 摄像头取决于大屏系统和 RTC 支持，必须实机测试。尚未用真实凭证验证云端生成和弱网效果。

本次只构建本地 APK，不替换 `public/app.apk`，不部署站点，不改后台配置或局域网运行服务。
