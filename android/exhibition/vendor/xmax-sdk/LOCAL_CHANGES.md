# XMAX Android SDK 1.0.9

Upstream: https://github.com/XingMai/XmaxSDK-Android
Pinned commit: `696852c61a6b403dd904e8eb91fd8a302c7802b6`.

MIT license and upstream third-party notices are retained. `UPSTREAM.json`
records upstream source hashes and the official release AAR / extracted JNI
SHA-256 checksums. No XLive application code or decompiled APK code is included.

## Model and service routing

The official `X2_1_1_PREVIEW_CN` and `X2_1_1_PREVIEW_US` models and their
model-specific realtime API addresses are unchanged. Android explicitly
negotiates the model family with the exhibition backend; issuance, verification,
usage and revocation use the persisted model and region. Existing browser
sessions remain on their earlier SDK/model. `XmaxEnvironment` retains the
existing canonical CN/global storage origins. Exhibition assets are prepared by
the backend and supplied as public reference URLs, without SDK uploads.

## Camera and gesture integration

The public camera extensions are retained: `enumerateCameraDevices()`,
`cameraCaptureInfo()`, and both `createLocalCameraStream` overloads accept
`cameraDeviceId`, `cameraRotationDegrees` and `captureFormat`.

Agora RTC 4.6.4 replaces VolcEngine. Android CameraManager enumerates camera IDs;
explicit selection uses Agora's `cameraId` configuration without a competing
cameraDirection. Missing IDs fail without selecting another camera. Enumeration
does not start capture or a provider session, and close releases the engine.

Capture width/height/fps remain independent of the model encoder. Explicit 4K
requests reach the capture pipeline, with `followEncodeDimensionRatio=false`.
Formats require positive even dimensions <=8192 and fps in 1..120. Actual first
frame geometry determines the nearest official model resolution bucket:
1024×1920 or 1920×1024. Connection preparation freezes that baseline; adaptive
transport quality does not overwrite the requested capture format.
`cameraCaptureInfo()` reports observed dimensions, not a sensor-resolution promise.

Installation correction accepts 0/90/180/270 degrees. The Agora READ_WRITE
capture observer combines it with the frame rotation exactly once, retaining the
buffer before replacement. Preview and encoding consume the corrected frame;
gesture samples keep the same rotation metadata. Encoder orientation follows the
resolved model format. Each capture resets its state; switching to external media
clears camera correction and orientation. Capture generations and engine leases
invalidate old geometry, readiness and pending samples.

The observer uses `VIDEO_PIXEL_DEFAULT` with READ_WRITE to preserve native
textures when available; rotation retains the same buffer and only accepted
`setLocalVideoFrameListener()` samples convert to I420 and copy their planes.
Agora's observer requests unmirrored pixels, so these samples carry
`isMirrored=false`; front-camera preview and encoding are mirrored through Agora
configuration. Agora renders local preview directly, replacing the former Volc
local sink/EGL workaround. Plane strides and buffer ownership are preserved;
queued samples are dropped after a source/listener change. No second camera is
opened for hand inference.

## Large-screen rendering

`XmaxVideoView` and `XmaxRealtimeVideoView` expose an optional
`maximumRenderPixels` limit (0 keeps the SDK default). The physical
TextureView surface is measured smaller and scaled back to the full display
bounds. Capture, encoding, raw gesture frames, outer layout and trajectory
coordinates remain independent. The exhibition main screen opts into a
1920×1080 pixel budget; the settings preview keeps its existing size. Existing
surface lifecycle, generation invalidation and first-presented-frame gates remain.

The optional `useSurfaceViewForLocalCamera` flag defaults to false. The exhibition
main screen enables it to keep camera video in a separate, below-window display
layer. Its view stays full size; `SurfaceHolder.setFixedSize` applies the render
pixel budget without changing the window hole. UI and remote video can cover
this layer. Camera binding opts into this path; remote/network rendering keeps
the original TextureView presentation gate. Unbinding precedes surface removal,
and local preview remains attached while the remote video is shown.

Trajectory overlays with no binding or with interaction disabled are `GONE`.
The built-in renderer does not allocate or draw an idle transparent full-screen
bitmap. It allocates trail pixels on the first segment and releases them after
fade completion, reset, resize or detach.

## Build and verification

The Gradle module consumes the official 1.0.9 release AAR's precompiled
`libxmax_yuv.so` and `libc++_shared.so` for all four published ABIs. It requires no
NDK or publication plugin. The old Volc Maven repository and Jetifier are removed.
Build tools: AGP 9.1.1, Gradle 9.3.1, JDK 17, Kotlin 2.3.21, compileSdk 37;
the application retains targetSdk 35 / minSdk 28 and the Android 11 decor fix.

Local camera/rotation tests and imported upstream model, media, connection,
quality and transport tests cover the migration. Device preview, capture and
startup are checked separately from paid cloud generation. Driver-dependent
capture and generated-video orientation still require target-device verification.
