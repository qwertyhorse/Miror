package ai.xmax.sdk

import ai.xmax.sdk.render.video.CameraRenderSurfaceView
import ai.xmax.sdk.render.video.FrameReportingTextureView
import ai.xmax.sdk.render.video.VideoRenderBinding
import ai.xmax.sdk.render.video.VideoRenderRegistry
import ai.xmax.sdk.render.video.VideoRenderSize
import android.content.Context
import android.os.Callbacks
import android.view.View

fun main() {
    var assertions = 0
    fun verify(value: Boolean, message: String) { check(value) { message }; assertions++ }
    fun size(view: View, width: Int = 1965, height: Int = 3333) {
        view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
        view.layout(0, 0, width, height)
    }
    val context = Context()
    val events = mutableListOf<String>()
    val camera = RealtimeVideoTrack("camera")
    var cameraOwner: XmaxVideoView? = null
    var cameraView: View? = null
    VideoRenderRegistry.register(camera, VideoRenderBinding(
        { view, _ ->
            view.prepareLocalCameraRendering()
            cameraOwner = view; cameraView = view.rtcRenderView
            events += "bind"
        },
        { view -> verify(view.rtcRenderView.parent === view, "Unbind runs before the surface is removed"); events += "unbind" },
    ))
    val terminal = XmaxRealtimeVideoView(context)
    verify(!terminal.useSurfaceViewForLocalCamera && terminal.maximumRenderPixels == 0, "SDK defaults remain texture and unlimited")
    terminal.useSurfaceViewForLocalCamera = true
    terminal.maximumRenderPixels = 1920 * 1080
    terminal.localTrack = camera
    terminal.onAttachedToWindow()
    size(terminal)
    val local = cameraView as CameraRenderSurfaceView
    val limited = VideoRenderSize.limited(1965, 3333, 1920 * 1080)
    verify(local.width == 1965 && local.height == 3333 && local.scaleX == 1f && local.scaleY == 1f,
        "SurfaceView and its window hole retain full layout and no View transform")
    verify(local.holder.fixedSizes.single() == limited.width to limited.height && local.zOrderChanges == 0,
        "Only holder buffers are limited; default below-window Z order remains untouched")
    size(terminal)
    verify(local.holder.fixedSizes.size == 1, "Unchanged layout does not request repeated fixed-size relayouts")

    val remote = RealtimeVideoTrack("remote")
    var remoteOwner: XmaxVideoView? = null
    var remoteTexture: FrameReportingTextureView? = null
    VideoRenderRegistry.register(remote, VideoRenderBinding(
        { view, _ -> view.prepareRtcVideoRendering(); remoteOwner = view; remoteTexture = view.rtcRenderView as FrameReportingTextureView },
        { view -> verify(view.rtcRenderView.parent === view, "Remote texture unbind precedes removal") },
    ))
    terminal.remoteTrack = remote
    size(terminal)
    val firstRemote = remoteTexture!!
    val staleDisplay = firstRemote.onFrameDisplayed!!
    verify(terminal.children.last() === cameraOwner && cameraView === local, "Waiting remote stays behind the unchanged local surface")
    firstRemote.present(0); Callbacks.flush()
    verify(terminal.children.last() === cameraOwner, "An empty texture does not satisfy first presentation")
    firstRemote.present(10); Callbacks.flush()
    verify(terminal.children.last() === remoteOwner && remoteOwner!!.animation.duration == 300L,
        "Presented remote texture comes above local and retains the existing fade")
    verify(local.parent === cameraOwner && local.isAttachedToWindow && local.visibility == View.VISIBLE,
        "Remote presentation retains the local surface for immediate fallback")
    terminal.remoteTrack = null
    verify(terminal.children.last() === cameraOwner && firstRemote.parent == null && !firstRemote.isAttachedToWindow,
        "Clearing remote removes its texture and immediately restores local layer order")
    terminal.remoteTrack = remote
    size(terminal)
    staleDisplay(firstRemote); Callbacks.flush()
    verify(remoteTexture !== firstRemote && terminal.children.last() === cameraOwner,
        "A replaced texture's stale presentation callback cannot reveal the new remote")
    remoteTexture!!.present(20); Callbacks.flush()
    verify(terminal.children.last() === remoteOwner, "The replacement remote waits for its own acquired buffer")
    terminal.remoteTrack = null

    terminal.useSurfaceViewForLocalCamera = false
    size(terminal)
    verify(cameraView is FrameReportingTextureView && local.parent == null && !local.isAttachedToWindow,
        "Disabling the opt-in unbinds/removes the SurfaceView and rebinds the same camera as TextureView")
    verify(events.takeLast(2) == listOf("unbind", "bind"), "Changing renderer preserves unbind-before-rebind ordering")
    terminal.useSurfaceViewForLocalCamera = true
    size(terminal)
    val replacement = cameraView as CameraRenderSurfaceView
    terminal.maximumRenderPixels = 0
    size(terminal)
    verify(cameraView === replacement && replacement.holder.layoutSizeRestores == 1,
        "Removing the pixel cap restores holder layout size without rebinding capture")
    terminal.maximumRenderPixels = 1920 * 1080
    size(terminal, 1080, 1920)
    verify(replacement.holder.fixedSizes.last() == 1080 to 1920 && replacement.width == 1080 && replacement.height == 1920,
        "Resize reapplies the pixel budget to buffers while keeping surface layout current")
    terminal.onDetachedFromWindow()
    verify(replacement.parent == null && !replacement.isAttachedToWindow, "Window detach unbinds and removes the native surface")
    terminal.onAttachedToWindow(); size(terminal)
    verify(cameraView is CameraRenderSurfaceView && cameraView !== replacement, "Window reattach gets a fresh camera renderer")
    terminal.localTrack = null
    verify(cameraView!!.parent == null, "Clearing the local track removes its renderer")
    terminal.onDetachedFromWindow()

    val network = XmaxVideoView(context)
    network.useSurfaceViewForLocalCamera = true
    network.onAttachedToWindow()
    verify(network.prepareNetworkVideoRendering() is FrameReportingTextureView,
        "Network playback remains a TextureView even with the camera-only opt-in")
    network.prepareRtcVideoRendering()
    val rtcTexture = network.rtcRenderView
    network.useSurfaceViewForLocalCamera = false
    verify(rtcTexture is FrameReportingTextureView && network.rtcRenderView === rtcTexture,
        "Remote RTC rendering stays texture and camera-only toggles do not recreate it")
    network.onDetachedFromWindow()
    VideoRenderRegistry.unregister(camera); VideoRenderRegistry.unregister(remote)
    println("VideoRenderLifecycle: $assertions assertions passed; actual SDK views with holder/lifecycle fixtures, no GPU/compositor claims")
}
