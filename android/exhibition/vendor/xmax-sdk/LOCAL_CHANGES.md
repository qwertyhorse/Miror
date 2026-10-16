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

The local camera API adds `enumerateCameraDevices()` and an optional
`cameraDeviceId` argument to `createLocalCameraStream`. Enumeration and exact
device selection use the pinned RTC SDK's `IVideoDeviceManager`; an unavailable
ID fails without falling back to another camera. Existing calls without an ID
retain their front/back selection. Enumeration creates no capture or network
session, and `close()` also releases an engine used only for enumeration.

Both `createLocalCameraStream` overloads additionally accept the optional
`cameraRotationDegrees` argument (default `0`; valid values `0`, `90`, `180`,
`270`). This is a clockwise installation correction, applied after camera
selection and before capture by the pinned RTC SDK's
`RTCEngine.setVideoCaptureRotation(VideoRotation)` API. It affects the camera
stream sent to XMAX as well as local rendering; it is not a TextureView-only
transform. Invalid angles fail with `INVALID_CONFIGURATION`; a failed RTC call
prevents capture and follows the existing cleanup path. Every camera stream
explicitly applies its angle, including `0`, so a previous correction cannot
silently carry over to the next camera stream.

Both overloads now accept a final optional `captureFormat:
RealtimeCameraCaptureFormat?` parameter. Its width, height, and fps are passed to
RTC capture without model-size downscaling, so a `3840 x 2160` request actually
reaches the camera pipeline. Dimensions must be positive even numbers no larger
than 8192, and fps must be in `1..120`. Omitting this parameter preserves the
previous model-adjusted capture request. The independent `videoFormat` continues
to specify model/encoder fps, bitrates and preference; capture fps does not
silently change the generation rate. Actual frame geometry still determines
model-aligned encoder and generation dimensions, so requesting 4K capture does
not send an unsupported 4K model size.

`cameraCaptureInfo()` returns the active camera's latest RTC-reported width,
height and rotation as `RealtimeCameraCaptureInfo`, or null when no valid camera
geometry is available. It does not initialize a manager, open a camera or start
a network session. This is the reported frame size rather than the requested
size; RTC/driver negotiation can differ, and the value is not a guarantee of the
sensor's native resolution. Stopping or switching away from capture clears it.
Tests cover 4K requests, all four rotations, model and encoder limits, driver
fallback, legacy requests, invalid formats and stale source callbacks.

Rotation metadata from `IVideoFrame.rotation()` is copied unchanged into local
analysis samples. The RTC frame renderer consumes the same metadata; neither
consumer adds `cameraRotationDegrees` again. JVM tests cover all four angles,
call ordering, invalid input, failed-configuration retry, reset to the default,
and preservation of frame rotation and I420 plane data. Physical device testing
is still required to verify driver-specific capture and generated-video output.

Camera first-frame and size-change callbacks also retain the raw dimensions and
RTC rotation. Only a captured first frame satisfies readiness. Before preview
READY, and again before each connection, the camera track resolves its effective
display dimensions through the model's existing alignment rules. The encoder and
generation events consume that same format; subsequent callbacks cannot change
an active connection's generation size. Capture generations and engine leases
fence stopped-source callbacks and pending readiness notifications. One diagnostic
line at connection preparation records raw size, rotation, and resolved model
size without credentials. Tests cover non-square frames at all four rotations,
already-rotated pixels, size updates, reconnection, and first/change-condition
payload consistency. Native callbacks do not provide a capture-generation ID,
so delayed native events still require physical-device verification.

Before configuring the encoder for an internal camera source, the RTC boundary
sets `VideoOrientation.PORTRAIT` or `LANDSCAPE` to match that resolved format.
The SDK applies frame rotation before encoding and resets its rotation metadata
to zero, so model input need not interpret a separate rotation flag. The saved
installation correction remains owned by `setVideoCaptureRotation`; it is never
added a second time. Each capture begins in `ADAPTIVE` to measure actual geometry
without a preceding session's fixed orientation. Switching to external image or
video input resets both orientation and capture correction before switching the
source; a failed reset prevents the switch. Pre-encoding configuration failures
prevent connection rather than silently sending an unadapted camera stream.
Preview and gesture sinks retain their existing frame-rotation handling.
This is frame orientation normalization, not automatic recognition of an upright
person. Driver-specific preview and XMAX output still need physical-device tests.
See the RTC [video orientation documentation](https://docs.byteplus.com/en/docs/byteplus-rtc/docs-128787).

The optional local video-frame listener exposes bounded CPU I420 samples from
the existing RTC capture for Android hand inference. Its local sink uses
`AFTER_PREPROCESS` so sampling and preview receive the camera correction and
mirror applied by RTC before transmission. A local sink replaces RTC's
VideoCanvas, so the existing EGL frame renderer also renders local preview;
it does not mirror these postprocessed pixels again. Local samples expose
`RealtimeVideoFrame.isMirrored` based on the applied RTC mirror mode. The host
uses it to normalize hand-inference input without changing preview or uploaded
video. Remote samples retain the default `false` and existing rendering behavior.
The listener never opens a second camera or changes
remote-frame/session confirmation. Capture samples are copied before the SDK
callback returns and are invalidated when the camera owner changes or closes.

The local Gradle file removes publication/native compilation tasks and consumes
the official 1.0.8 AAR's precompiled `libxmax_yuv.so` and `libc++_shared.so` for
all four published ABIs. An NDK installation is therefore unnecessary.

Build tools: AGP 9.1.1 (the minimum supporting API 37), Gradle 9.3.1, JDK 17,
Kotlin 2.3.21, compileSdk 37. The host retains targetSdk 35 and minSdk 28.
