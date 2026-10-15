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

`accept` 的手数据为 `[{ handedness: "Left", landmarks: [{x, y, z}, ...] }]`。坐标应对应输入画面，宽高比使用同一画面宽 / 高；时间戳使用单调时钟。没有手时必须持续提交空数组，才能计入收手。双手保留完整数组，检测器将未能确认归属的双手视为歧义。当前原生桥不提供人体姿态，调用检测器的已有单手归属路径；原生推理不需要为了状态机另跑人体模型。

每次最多一个帧计算在途；加载中、在途时和倒序帧直接丢弃，返回 `false`，不排队。`configure`、忙碌边界和 `reset` 会使先前在途结果失效。忙碌时仍应提交手帧，用于观察释放；`setBlocked` 本身不会关闭摄像头或推理。`reset` 保留已消费手掌状态，持续举着的手不会因停止或重试再次触发。`bridge.retry()` 仅重新初始化仍存活的 JS 检测器并保留已消费手势。Activity 的“重试手势”会重建整个识别实例（包含已退出的 WebView renderer）；切换模式、重新配置或重建实例后，先连续观察空手至少500ms，相邻空手采样间隔必须小于800ms，任何手出现立即重新计时。这个启动释放栅栏不改变检测器正常动作的350ms最大采样间隔。新的摄像头推理 generation 必须由调用方过滤，不能把旧 generation 的结果重新递交。

`onState` 包含 `event`、`timestamp`、`blocked`、`operatorStatus`、`controlSource`、`ambiguityReason`、`handDetected`、`handRaised`、`armed`、`needsRelease`、`confirmationState`、`palmHoldMs`、`rawHandCount`、`matchedHandCount`。应使用该结果当前帧的状态，不能用上一帧状态否决已经确认的事件。Activity 在最终提交动作前重新检查结果年龄小于800ms、当前权限、忙碌与同步防重复状态；迟到的 JS 回调也不能触发。

## Linux 模式

`NativeRemoteGestures` 将 RTC 旋转纠正后的未镜像画面缩至长边480像素，以JPEG质量70上传同一后台的 `/v1.1/api/exhibition/mirrors/:id/gestures/*`。每张最多256KiB，最高10FPS，任何时刻只拥有一个编码/上传中的帧，忙时直接关闭后续帧，不排队。HTTP使用保持配置域名、证书校验与LAN DNS的独立连接客户端；帧请求总时限1200ms，握手15秒，POST不自动重试。

每个会话独立携带设备凭证、sessionId、单调epoch/seq/采样时间和blocked。忙碌、配置或作用域变化立即失效旧响应，忙碌帧仍可观察释放；控制响应只更新反馈，永远不能触发操作。当前epoch且年龄小于800ms的帧响应才进入Activity的最后检查。网络失败会丢弃当前帧、失效会话并退避重开；新会话先放手，不补执行旧动作。关闭Activity或切换模式会释放远端会话。服务端按后台参数执行同一V1.1检测器。

## 生成与验证

```sh
node scripts/build-android-gesture.mjs
node scripts/build-android-gesture.mjs --check
node node_modules/vitest/vitest.mjs run tests/nativeGestureRuntime.test.ts
node scripts/check-android-gesture-chromium.mjs /path/to/chromium-74/chrome
sh android/exhibition/scripts/test-native.sh
```

源代码与已打包 bundle 的逐字节一致性由测试检查。浏览器合同测试使用真实 Chromium 74，覆盖默认 0 → 310ms 首次确认、持续展掌、忙碌期间的展掌/挥手/第二只手、释放、重试和迟到帧。JVM fixture 验证忙碌边界、停止及关闭后迟到 JavaScript 回调不能触发指令，并用真实HTTP临时后台验证上传单帧背压、epoch失效、800ms时效、1200ms网络时限、断线重开与Bitmap所有权。Android instrumentation使用真实旧WebView、Activity、网络和检测器；x86模拟器不支持供应商RTC库，测试只替换相机就绪和推理输入边界，不作为真实设备摄像头或XMAX视频验收。
