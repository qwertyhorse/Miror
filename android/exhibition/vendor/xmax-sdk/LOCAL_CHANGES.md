# XMAX Android SDK 1.0.8

Upstream: https://github.com/XingMai/XmaxSDK-Android

Pinned commit: `14ed6e1327f82c58bb17ea93910d301caee80aea`.

The upstream MIT license and third-party notices are retained. `UPSTREAM.json`
records upstream source hashes, the official Maven AAR hash, and each extracted
JNI library hash. No XLive application code is included.

`XmaxEnvironment.kt`: China and global Open API
roots use `https://api.xmaxai.com/open/api/v1` and
`https://api.xmax.ai/open/api/v1`, matching the existing exhibition backend's
temporary-key, session verification, and teardown services. The application
accepts only the `x2.0` model.

The local camera API adds `enumerateCameraDevices()` and an optional final
`cameraDeviceId` argument to `createLocalCameraStream`. Enumeration and exact
device selection use the pinned RTC SDK's `IVideoDeviceManager`; an unavailable
ID fails without falling back to another camera. Existing calls without an ID
retain their front/back selection. Enumeration creates no capture or network
session, and `close()` also releases an engine used only for enumeration.

The local Gradle file removes publication/native compilation tasks and consumes
the official 1.0.8 AAR's precompiled `libxmax_yuv.so` and `libc++_shared.so` for
all four published ABIs. An NDK installation is therefore unnecessary.

Build tools: AGP 9.1.1 (the minimum supporting API 37), Gradle 9.3.1, JDK 17,
Kotlin 2.3.21, compileSdk 37. The host retains targetSdk 35 and minSdk 28.
