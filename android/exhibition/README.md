# OpenBuy 展会试衣镜 Android 原生版

应用版本 **0.2.5 / versionCode 8**，包名 `ai.openbuy.exhibition`。启动入口是原生 `NativeExhibitionActivity`，使用 XMAX 官方 Android SDK 1.0.8 和火山 RTC，不再依赖 Android System WebView 版本。旧 WebView Activity 仅保留为非导出内部类。

## 安装使用

1. 将 `OpenBuy-展会试衣镜-0.2.5.apk` 发送到大屏安装，允许摄像头权限。
2. 首次显示四位绑定码，在现有 V1.1 展会后台绑定到对应智能镜。升级旧包沿用原来的安装身份与绑定。
3. 在后台配置该镜的 XMAX 密钥、区域、额度及素材；选择素材后点击“开始体验”。永久密钥不写入 APK。

默认连接 `https://xuminghong.local:10202/v1.1/exhibition/screen` 对应的原生 API。设备须能访问 Mac 的局域网地址；XMAX 生成需要互联网。管理后台入口为 `http://xuminghong.local:10200/`。

右上角“设置”可更改展台网址、备用 IP 和摄像头。系统无法解析默认 `.local` 域名时，应用通过 NSD 自动发现同一局域网的 Miror 后台；发现窗口最长 3 秒，随后释放 Wi-Fi 多播锁。若路由器限制多播，可在“备用 IP”填写后台 Mac 的私有 IPv4 地址，展台网址保持默认域名。网络请求仍使用默认域名完成 TLS、Host 与 Origin 校验，备用 IP 只影响连接地址。留空恢复自动发现。

debug 包只对默认域名信任随包 CA 公钥，不跳过 TLS 或主机名验证。直接配置 IP 的 HTTPS 地址仍须匹配证书。HTTP 10200 的旧镜端地址会规范化为同主机 HTTPS 10202。

0.2.4 首次启动时会将空的备用 IP 预填为当前展会 Mac 地址 `192.168.63.54`，保留已填写的其他地址；之后仍可修改或清空。兼容旧安卓解析 XMAX 返回的带时区到期时间（如 `+00:00`），实际到期与无效时间仍会停止并释放会话。

## 摄像头选择

设备设置支持自动选择、实际摄像头列表和“重新检测”。列表使用 RTC 的真实设备 ID；自动选择优先系统确认的外接摄像头，再选后置、前置。选中后在设置内验证本地取景，保存后记住选择，取消保持原配置。生成或停止尚未结束时，先停止生成再切换摄像头。

检测和取景不申请临时 key、不创建 XMAX 生成会话。手动选中的设备消失时不会自动换到另一台。系统只识别到 USB 视频设备、RTC 无可用设备等情况会显示简短反馈；本版本不包含独立 USB/UVC 驱动，也不承诺自动热插拔恢复。更换或插拔后点“重新检测”。

## 应用行为

- 镜端沿用网页版的 9:16 品牌布局、Logo、舞台内按钮及左侧素材抽屉；后台皮肤和素材栏单／双列设置同步生效。自定义皮肤完整铺底，预览和生成视频按网页 cover 方式填满舞台。
- 主画面保持原生摄像头和 XMAX SDK；安卓暂未接入网页手势识别，界面不展示虚假的识别状态。

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

测试采用隔离 HTTP/HTTPS fixture 与假的供应商控制器，不访问真实后台或 XMAX、不消耗额度。覆盖 API 契约、DNS 备用地址与缓存、TLS 域名和证书校验、丢失响应不重复申请凭证、会话 metadata、生成顺序及取消/清理。本轮执行范围与验收边界见 `../../docs/OPTIMIZATION.md`。

## SDK 来源与限制

官方来源：https://github.com/XingMai/XmaxSDK-Android ，固定 commit `14ed6e1327f82c58bb17ea93910d301caee80aea`。MIT 许可证保留在 `vendor/xmax-sdk/LICENSE`，`UPSTREAM.json` 记录源码和 JNI SHA-256。

SDK 源码调整国内/国际两个 API 根地址，并补充 RTC 摄像头枚举和按设备 ID 选择；具体差异见 `vendor/xmax-sdk/LOCAL_CHANGES.md`。JNI 来自官方 Maven 1.0.8 AAR，包含 arm64-v8a、armeabi-v7a、x86、x86_64。未使用原 APK 的反编译代码或签名。

当前官方 `libxmax_yuv.so` 未做 16KB 页对齐，16KB 页 Android 设备需重编该库后验证。SDK 未透传所有摄像头热拔异常；外接 USB 摄像头取决于大屏系统和 RTC 支持，必须实机测试。尚未用真实凭证验证云端生成和弱网效果。

本次只构建本地 APK，不替换 `public/app.apk`，不部署站点，不改后台配置或局域网运行服务。
