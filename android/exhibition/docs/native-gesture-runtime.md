# 安卓双模式手势与 V1.1 检测器共用

设备设置中的“手势识别”可选择“安卓本机”或“Linux电脑”，默认 Linux电脑。两种模式均从同一原生 RTC 摄像头抽帧，主视频仍由安卓直接连接 XMAX，不开启第二个摄像头。

安卓本机模式由原生 CPU Hand Landmarker 处理摄像头画面；只有归一化关键点进入 `NativeGestureBridge`。Bridge 的隐藏 WebView 只执行安装包内的 `detector.js`，不显示网页、不加载网络、不读取文件或浏览器存储，也没有 JavaScript interface。它不使用 MediaPipe Web、WASM、WebRTC 或页面 CSS。

`detector.js` 由 `src/exhibition/nativeGestureRuntime.ts` 引入现有 `mirrorGestureDetector.ts`、`gestureDetector.ts`、`raiseGestureDetector.ts` 生成，以 Chrome 69 语法为目标。`Array.at` 的局部运行环境补足随包提供。换装忙碌、释放和防重复规则来自同一份 V1.1 TypeScript 实现。

## 调用接口

以下接口全部在 Android 主线程调用：

```kotlin
val bridge = NativeGestureBridge(context,
    onState = { state: JSONObject -> /* event 为 null、open_palm 或 wave */ },
    onError = { message: String -> /* 简短错误反馈 */ })
bridge.configure(settingsJSONObject)
bridge.setBlocked(isBusy)
bridge.accept(timestampMs, handsJSONArray, frameAspectRatio)
bridge.reset()
bridge.retry()
bridge.close()
```

`accept` 的手数据为 `[{ handedness: "Left", landmarks: [{x, y, z}, ...] }]`。坐标应对应输入画面，宽高比使用同一画面宽 / 高；时间戳使用单调时钟。没有手时必须持续提交空数组，才能计入收手。双手保留完整数组，检测器分别跟踪每只手，任一只符合已启用手势即触发；两只同时符合只产生一个动作，持续举手不重复。数组顺序和 handedness 变化不应被当成新手。当前原生桥不提供人体姿态，直接使用共享检测器的手部路径，无需另跑人体模型。

所有手均未检出并持续达到 `palmReleaseMs`（默认500ms）即自动复位；人体仍在、冻结或变化都不阻止复位。短暂漏检不解除已触发动作的锁定。

每次最多一个帧计算在途；加载中、在途时和倒序帧直接丢弃，返回 `false`，不排队。`configure`、忙碌边界和 `reset` 会使先前在途结果失效。忙碌时仍应提交手帧，用于观察释放；`setBlocked` 本身不会关闭摄像头或推理。`reset` 保留已消费手掌状态，持续举着的手不会因停止或重试再次触发。`bridge.retry()` 仅重新初始化仍存活的 JS 检测器并保留已消费手势。Activity 的“重试手势”会重建整个识别实例（包含已退出的 WebView renderer）；切换模式、重新配置或重建实例后，先连续观察空手至少500ms，相邻空手采样间隔必须小于800ms，任何手出现立即重新计时。这个启动释放栅栏不改变检测器正常动作的350ms最大采样间隔。新的摄像头推理 generation 必须由调用方过滤，不能把旧 generation 的结果重新递交。

`onState` 包含 `event`、`timestamp`、`blocked`、`operatorStatus`、`controlSource`、`ambiguityReason`、`handDetected`、`handRaised`、`armed`、`needsRelease`、`confirmationState`、`palmHoldMs`、`rawHandCount`、`matchedHandCount`。应使用该结果当前帧的状态，不能用上一帧状态否决已经确认的事件。Activity 在最终提交动作前重新检查结果年龄小于800ms、当前权限、忙碌与同步防重复状态；迟到的 JS 回调也不能触发。

## Linux 模式

`NativeRemoteGestures` 将 RTC 旋转纠正后的未镜像画面按后台 `inputLongEdge`（480/720/960，默认720）及 `maxFps`（5–30，默认15）抽样并上传同一后台的 `/v1.1/api/exhibition/mirrors/:id/gestures/*`。RTC 的 YUV 转换同步使用该尺寸，避免先降至640；不放大原始小画面，不改变 XMAX 主视频采集或编码。JPEG 从质量82开始，超过256KiB时逐级降低质量，不再降低尺寸；仍无法满足上限则丢弃。任何时刻只拥有一个编码/上传中的帧，忙时直接关闭后续帧，不排队；实际帧率由采集、编码、网络及推理共同决定。HTTP使用保持配置域名、证书校验与LAN DNS的独立连接客户端；帧请求总时限1200ms，握手15秒，POST不自动重试。

每个会话独立携带设备凭证、sessionId、单调epoch/seq/采样时间和blocked。忙碌、配置或作用域变化立即失效旧响应，忙碌帧仍可观察释放；控制响应只更新反馈，永远不能触发操作。当前epoch且年龄小于800ms的帧响应才进入Activity的最后检查。网络失败会丢弃当前帧、失效会话并退避重开；新会话先放手，不补执行旧动作。关闭Activity或切换模式会释放远端会话。服务端按后台参数执行同一V1.1检测器。

0.6.8 起尺寸、帧率配置变化会使正在转换、编码或等待响应的旧帧失效，新的识别周期需先收手；本机模式仍保留640像素与10FPS上限。新服务兼容旧 APK，完整输入及提示对齐需升级0.6.8。

Linux 推理同时返回人体姿态与手部关键点。0.6.9 起网页、Linux 与安卓本机统一采用双手逐手识别：任一只符合即触发，两只同时符合只执行一次；无人体、丢失手腕归属或多人入镜不再单独否决有效手势。人体姿态仅辅助可信的下放判断；安卓本机仍只提交手部关键点，通过握拳或收手释放。忙碌期间的动作不排队、不补执行。安卓端只消费服务端结果，不重新判断手数。Linux 模式的 `confirmationState=raise_required` 显示“可以再次抬手”，优先于 `needsRelease`；`lowering` 和 `already_triggered` 显示“请放下手”。本地启动收手栅栏保持原优先级。

## 生成与验证

```sh
node scripts/build-android-gesture.mjs
node scripts/build-android-gesture.mjs --check
node node_modules/vitest/vitest.mjs run tests/nativeGestureRuntime.test.ts
node scripts/check-android-gesture-chromium.mjs /path/to/chromium-74/chrome
sh android/exhibition/scripts/test-native.sh
```

源代码与已打包 bundle 的逐字节一致性由测试检查。浏览器合同测试使用真实 Chromium 74，覆盖默认 0 → 310ms 首次确认、双手任选有效手势、双手同时只触发一次、持续展掌、忙碌期间的展掌/挥手/第二只手、释放、重试和迟到帧。JVM fixture 验证忙碌边界、停止及关闭后迟到 JavaScript 回调不能触发指令，并用真实HTTP临时后台验证上传单帧背压、epoch失效、800ms时效、1200ms网络时限、断线重开与Bitmap所有权。Android instrumentation使用真实旧WebView、Activity、网络和检测器；x86模拟器不支持供应商RTC库，测试只替换相机就绪和推理输入边界，不作为真实设备摄像头或XMAX视频验收。
