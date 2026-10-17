package ai.openbuy.exhibition

import android.content.Context
import android.media.MediaCodecInfo
import android.os.FixtureMain
import android.widget.FrameLayout
import org.json.JSONObject
import org.webrtc.*
import org.webrtc.audio.JavaAudioDeviceModule

/** Exercises the real receiver with scheduled native callbacks, without a camera/network/GPU. */
fun main() {
    var assertions = 0
    fun verify(value: Boolean, message: String) { check(value) { message }; assertions++ }
    val signals = mutableListOf<Pair<String, JSONObject>>()
    val readiness = mutableListOf<Boolean>()
    val errors = mutableListOf<String>()
    val receipts = mutableListOf<Pair<Long, Long>>()
    HardwareVideoDecoderFactory.candidates = listOf(MediaCodecInfo(capabilities =
        MediaCodecInfo.CodecCapabilities(arrayOf(MediaCodecInfo.CodecProfileLevel(
            MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline, MediaCodecInfo.CodecProfileLevel.AVCLevel51)))))
    val receiver = NativeComputerVideoReceiver(Context(), { kind, body -> signals += kind to body },
        readiness::add, errors::add, { epoch, id -> receipts += epoch to id })
    fun offer(epoch: Long) = receiver.receive("offer", JSONObject().put("epoch", epoch).put("type", "offer").put("sdp", "fixture-sdp"))
    fun candidate(epoch: Long, value: String = "fixture-candidate") = receiver.receive("candidate", JSONObject()
        .put("epoch", epoch).put("candidate", value).put("sdpMid", "video").put("sdpMLineIndex", 1))
    fun remoteReady(peer: PeerConnection) { peer.remoteObserver!!.onSetSuccess(); FixtureMain.drain() }
    fun answerReady(peer: PeerConnection) {
        peer.answerObserver!!.onCreateSuccess(SessionDescription(SessionDescription.Type.ANSWER, "fixture-answer"))
        FixtureMain.drain()
        peer.localObserver!!.onSetSuccess(); FixtureMain.drain()
    }

    verify(PeerConnectionFactory.factories.isEmpty(), "Constructing the view initialized native media")
    candidate(1)
    verify(PeerConnectionFactory.peers.isEmpty(), "Pre-offer ICE started a peer")
    offer(1)
    val first = PeerConnectionFactory.peers.single()
    verify(first.configuration.iceServers.isEmpty() && first.configuration.sdpSemantics == PeerConnection.SdpSemantics.UNIFIED_PLAN,
        "Receiver used external ICE servers or Plan B")
    verify(!first.audioRecording && !first.audioPlayout, "Receiver enabled audio recording/playout")
    verify(first.video.sinks.isEmpty() && readiness.isEmpty(), "Receiver was ready before remote SDP/frames")
    remoteReady(first)
    verify(first.candidates.size == 1, "Pre-offer ICE was lost before setRemoteDescription completed")
    verify(first.transceivers[0].selectedDirection == RtpTransceiver.RtpTransceiverDirection.INACTIVE && !first.audio.enabled,
        "Incoming audio was not made inactive")
    verify(first.transceivers[1].selectedDirection == RtpTransceiver.RtpTransceiverDirection.RECV_ONLY
        && first.transceivers[1].codecs.first().name == "H264", "Video was not receive-only with H264 preferred")
    verify(PeerConnectionFactory.factories.single().decoderFactory is NativeComputerVideoDecoderFactory &&
        first.transceivers[1].codecs.first().parameters["profile-level-id"] == "42001f" &&
        first.transceivers[1].codecs.any { it.parameters["profile-level-id"] == "42e01f" },
        "Receiver did not prefer hardware ordinary baseline while retaining constrained baseline after JNI reordering")
    val renderer = first.video.sinks.single()
    verify(signals.isEmpty(), "Answer was sent before setLocalDescription")
    answerReady(first)
    verify(signals.single().first == "answer" && signals.single().second.getLong("epoch") == 1L,
        "Answer lost its offer epoch")
    first.observer.onIceCandidate(IceCandidate(null, 1, "local-fixture")); FixtureMain.drain()
    verify(signals.last().first == "candidate" && signals.last().second.getLong("epoch") == 1L
        && signals.last().second.isNull("sdpMid"), "Local ICE lost epoch or nullable mid")
    first.observer.onConnectionChange(PeerConnection.PeerConnectionState.CONNECTED); FixtureMain.drain()
    verify(readiness.isEmpty(), "Connected signaling was mistaken for a displayed frame")
    renderer.renderFrame()
    verify(readiness.isEmpty(), "Render callback bypassed the Main dispatch/epoch check")
    FixtureMain.drain()
    verify(readiness == listOf(true), "Rendered first frame did not mark ready")
    verify(renderer.scaling == RendererCommon.ScalingType.SCALE_ASPECT_FILL,
        "Existing camera preview no longer fills the native stage")
    receiver.setPagePresentation(true)
    verify(renderer.scaling == RendererCommon.ScalingType.SCALE_ASPECT_FIT && !readiness.last(),
        "Page mode cropped UI or retained the previous source's ready frame")
    renderer.renderFrame(); FixtureMain.drain()
    verify(readiness.last(), "Page first frame did not restore readiness")
    val clearBeforeStop = renderer.clearCount
    receiver.setPagePresentation(true, active = false)
    verify(!readiness.last() && renderer.clearCount > clearBeforeStop,
        "Stopped page capture retained a stale frame")
    renderer.renderFrame(); FixtureMain.drain()
    verify(!readiness.last(), "Late frames revived a stopped page capture")
    receiver.setPagePresentation(true, active = true)
    verify(!readiness.last() && renderer.firstFrameListeners.size == 1,
        "Restarted page did not wait for a fresh rendered frame")
    renderer.renderFrame(); FixtureMain.drain()
    verify(readiness.last(), "Restarted page did not become ready")
    verify(receipts.isEmpty(), "Legacy page metadata invented a rendered receipt")
    receiver.setPagePresentation(true, active = false, presentationId = 0)
    val stoppedBatchFrame = renderer.firstFrameListeners.last()
    receiver.setPagePresentation(true, active = true, presentationId = 1)
    stoppedBatchFrame(null); FixtureMain.drain()
    verify(receipts.isEmpty() && !readiness.last(), "An old presentation frame confirmed a new batch")
    renderer.renderFrame(); FixtureMain.drain()
    verify(receipts == listOf(1L to 1L) && readiness.last(), "Rendered receipt lost its epoch or batch")
    receiver.setPagePresentation(true, active = true, presentationId = 1)
    renderer.renderFrame(); FixtureMain.drain()
    verify(receipts.size == 1, "Duplicate presentation metadata emitted another rendered receipt")
    receiver.setPagePresentation(true, active = false, presentationId = 2)
    renderer.renderFrame(); FixtureMain.drain()
    verify(receipts.size == 1 && !readiness.last(), "Stopped page emitted a rendered receipt")
    receiver.setPagePresentation(true, active = true, presentationId = 3)
    renderer.renderFrame(); FixtureMain.drain()
    verify(receipts.last() == 1L to 3L, "A restarted batch did not wait for and confirm a new frame")
    receiver.setPagePresentation(false)
    verify(renderer.scaling == RendererCommon.ScalingType.SCALE_ASPECT_FILL,
        "Leaving page mode did not restore native stage scaling")
    receiver.setMirrored(true)
    verify(renderer.mirrored, "Presentation mirror was not applied in the renderer")
    renderer.getHolder().setFixedSize(2160, 3840)
    renderer.getHolder().setFixedSize(2160, 3840)
    renderer.getHolder().setSizeFromLayout()
    verify(renderer.actualHolder.requestedSizes == listOf(1080 to 1920), "Unknown input allocated a full 4K surface")
    verify(renderer.width == 2160 && renderer.height == 3840, "Surface cap changed the outer view layout")
    for ((width, height) in listOf(0 to 0, 1920 to 1080, 2160 to 3840, 3840 to 2160,
        4000 to 1000, 1 to Int.MAX_VALUE, Int.MAX_VALUE to 1, Int.MAX_VALUE to Int.MAX_VALUE)) {
        for (budget in listOf(1L, 1280L * 720, 1920L * 1080, 3840L * 2160, Long.MAX_VALUE)) {
            val size = computerVideoSurfaceSize(width, height, budget)
            verify(size.first >= 1 && size.second >= 1 && size.first.toLong() * size.second <= minOf(budget, 3840L * 2160)
                && maxOf(size.first, size.second) <= 3840 && minOf(size.first, size.second) <= 2160,
                "Surface budget failed for ${width}x$height/$budget: $size")
        }
    }
    verify(computerVideoSurfaceSize(3840, 2160) == 3840 to 2160 && computerVideoSurfaceSize(2160, 3840) == 2160 to 3840,
        "4K landscape or portrait surface was limited to 1080p")
    val buffers = mutableListOf<FixtureVideoBuffer>()
    fun frame(width: Int, height: Int, rotation: Int = 0): VideoFrame {
        val buffer = FixtureVideoBuffer(width, height).also(buffers::add)
        return VideoFrame(buffer, rotation, 123_456_789L)
    }
    receiver.setRotation(90)
    val landscape4k = frame(3840, 2160)
    val original4k = landscape4k.buffer
    Thread({ renderer.onFrame(landscape4k) }, "fixture-decoder").apply { start(); join() }
    verify(renderer.actualHolder.requestedSizes.last() == 1080 to 1920 && FixtureMain.pendingCount == 1,
        "Decoder thread resized the holder or queued multiple UI tasks")
    verify(renderer.lastFrame !== landscape4k && renderer.lastFrame!!.buffer === original4k
        && renderer.lastFrame!!.rotation == 90 && renderer.lastFrame!!.rotatedWidth == 2160
        && renderer.lastFrame!!.rotatedHeight == 3840 && renderer.lastFrame!!.timestampNs == landscape4k.timestampNs,
        "Display rotation copied pixels, lost metadata, or did not rotate the landscape decode")
    verify(original4k.references == 2 && original4k.retainCalls == 2 && original4k.releaseCalls == 1,
        "Rotation wrapper did not balance its own buffer retain/release")
    landscape4k.release(); FixtureMain.drain()
    verify(renderer.actualHolder.requestedSizes.last() == 2160 to 3840 && original4k.references == 1,
        "An actual 4K frame could not enable a 4K surface")
    val fixed4kCount = renderer.actualHolder.requestedSizes.size
    repeat(10) { frame(3840, 2160).also { renderer.onFrame(it); it.release() } }
    verify(FixtureMain.pendingCount == 0 && renderer.actualHolder.requestedSizes.size == fixed4kCount,
        "Steady 4K frames flooded the UI resize queue")
    val downscaled = frame(1920, 1080)
    renderer.onFrame(downscaled); downscaled.release(); FixtureMain.drain()
    verify(renderer.actualHolder.requestedSizes.last() == 1080 to 1920,
        "Returning to 1080p retained the expensive 4K surface budget")
    renderer.getHolder().setSizeFromLayout()
    verify(renderer.actualHolder.requestedSizes.last() == 1080 to 1920,
        "A layout callback expanded 1080p input to the entire 4K screen")
    // Metadata rotation composes with transport rotation and must retain the exact decoder buffer.
    for (configured in listOf(0, 90, 180, 270)) for (incoming in listOf(0, 90, 180, 270)) {
        receiver.setRotation(configured)
        val input = frame(1920, 1080, incoming)
        renderer.onFrame(input)
        verify(renderer.lastFrame!!.rotation == (configured + incoming) % 360
            && renderer.lastFrame!!.buffer === input.buffer && input.buffer.references == 2,
            "Frame/configured rotation ownership failed for $incoming + $configured")
        if (configured == 0) verify(renderer.lastFrame === input && input.buffer.retainCalls == 1,
            "Unrotated display unnecessarily wrapped/retained a frame")
        input.release()
    }
    try { receiver.setRotation(45); error("Accepted unsupported rotation") } catch (_: IllegalArgumentException) { assertions++ }
    receiver.setRotation(90)
    // Resolution bursts coalesce to the latest size without allocating a transient 4K buffer.
    val sizesBeforeBurst = renderer.actualHolder.requestedSizes.size
    frame(3840, 2160).also { renderer.onFrame(it); it.release() }
    frame(1280, 720).also { renderer.onFrame(it); it.release() }
    verify(FixtureMain.pendingCount == 1, "Resolution changes were not coalesced")
    FixtureMain.drain()
    verify(renderer.actualHolder.requestedSizes.size == sizesBeforeBurst + 1
        && renderer.actualHolder.requestedSizes.last() == 720 to 1280,
        "Resolution burst allocated a stale intermediate 4K surface")
    // Actual 4K mirror stage geometry from the Amlogic log. The original split update first
    // allocated 1076x1826 / 807x1369 using old geometry and then 1024x1736 / 768x1302.
    renderer.width = 1965; renderer.height = 3333
    receiver.setRotation(0)
    fun verifySingleResize(width: Int, height: Int, expected: Pair<Int, Int>) {
        val before = renderer.actualHolder.requestedSizes.toList()
        val input = frame(width, height)
        Thread({ renderer.onFrame(input) }, "fixture-decoder").apply { start(); join() }
        input.release()
        verify(renderer.actualHolder.requestedSizes == before,
            "Resolution callback resized the mirror surface before Main dispatch")
        verify(FixtureMain.pendingCount == 1, "Frame geometry and pixel budget were queued independently")
        FixtureMain.drain()
        verify(renderer.actualHolder.requestedSizes.drop(before.size) == listOf(expected),
            "${width}x$height allocated an intermediate surface: ${renderer.actualHolder.requestedSizes.drop(before.size)}")
    }
    verifySingleResize(1024, 1920, 1024 to 1736)
    verifySingleResize(768, 1440, 768 to 1302)
    verifySingleResize(1024, 1920, 1024 to 1736)
    receiver.setRotation(90)
    verifySingleResize(3840, 2160, 1965 to 3333)
    receiver.setRotation(0)
    verifySingleResize(1024, 1920, 1024 to 1736)
    // Same pixel count can change the cropped holder geometry; rotation must not be skipped.
    receiver.setRotation(90)
    verifySingleResize(1024, 1920, 603 to 1024)
    receiver.setRotation(0)
    verifySingleResize(1024, 1920, 1024 to 1736)
    receiver.setRotation(90)
    verify(renderer.actualHolder.requestThreads.none { it == "fixture-decoder" }, "SurfaceHolder was called off Main")
    first.observer.onIceConnectionChange(PeerConnection.IceConnectionState.DISCONNECTED)
    first.observer.onIceConnectionChange(PeerConnection.IceConnectionState.DISCONNECTED)
    FixtureMain.drain()
    verify(readiness.last() == false && renderer.firstFrameListeners.size == 1, "Reconnect readiness was not bounded")
    verify(renderer.clearCount > clearBeforeStop + 1, "Lost network left the last page frame visible")
    renderer.renderFrame(); FixtureMain.drain()
    verify(readiness.last(), "Frames after a short ICE interruption never restored readiness")

    receiver.setPagePresentation(true)
    candidate(2, "next-epoch")
    offer(2)
    val second = PeerConnectionFactory.peers.last()
    verify(first.disposed && renderer.released && first.video.sinks.isEmpty(), "New offer leaked the old peer/sink/renderer")
    verify(buffers.all { it.references == 0 }, "Replacing a peer leaked decoded frame buffers")
    verify(!readiness.last(), "New offer kept stale readiness")
    val signalCount = signals.size
    first.localObserver!!.onSetSuccess()
    first.observer.onIceCandidate(IceCandidate("video", 1, "stale-local"))
    first.observer.onIceConnectionChange(PeerConnection.IceConnectionState.FAILED)
    candidate(1, "stale-remote")
    FixtureMain.drain()
    verify(signals.size == signalCount && errors.isEmpty() && !second.disposed,
        "Old native callbacks polluted the replacement peer")
    remoteReady(second)
    verify(second.candidates.single().sdp == "next-epoch", "ICE queue crossed offer epochs")
    verify(second.video.sinks.single().mirrored, "Mirror preference was lost when replacing a peer")
    verify(second.video.sinks.single().scaling == RendererCommon.ScalingType.SCALE_ASPECT_FIT,
        "Replacing a page peer lost uncropped full-frame scaling")
    val rotatedReplacement = frame(1920, 1080)
    second.video.sinks.single().onFrame(rotatedReplacement)
    verify(second.video.sinks.single().lastFrame!!.rotation == 90, "Rotation preference was lost when replacing a peer")
    rotatedReplacement.release()
    answerReady(second)
    verify(signals.last().second.getLong("epoch") == 2L, "Replacement answer reused an old epoch")
    offer(2); offer(1)
    verify(PeerConnectionFactory.peers.size == 2, "Duplicate/stale offer rebuilt the peer")
    val secondRenderer = second.video.sinks.single()
    secondRenderer.renderFrame(); FixtureMain.drain()
    second.observer.onRemoveTrack(second.transceivers[1].receiver)
    FixtureMain.drain()
    verify(secondRenderer.released && second.video.sinks.isEmpty() && !readiness.last(), "Removed track retained its sink or readiness")
    second.observer.onAddTrack(second.transceivers[1].receiver, emptyArray()); FixtureMain.drain()
    val replacementRenderer = second.video.sinks.single()
    verify(replacementRenderer !== secondRenderer && !readiness.last(), "Replacement track reused stale first-frame state")
    replacementRenderer.renderFrame(); FixtureMain.drain()
    verify(readiness.last(), "Replacement track first frame was not accepted")

    receiver.reset()
    verify(second.disposed && (receiver.view as FrameLayout).children.isEmpty() && !readiness.last(), "Reset leaked peer/view resources")
    offer(1)
    val third = PeerConnectionFactory.peers.last()
    verify(third !== second, "Reset did not allow a new display session to restart at epoch 1")
    remoteReady(third)
    verify(third.candidates.isEmpty(), "Reset carried ICE from another display session")
    val thirdRenderer = third.video.sinks.single()
    val lateRendered = thirdRenderer.firstFrameListeners.single()
    thirdRenderer.getHolder().setSizeFromLayout()
    val sizesBeforeClose = thirdRenderer.actualHolder.requestedSizes.toList()
    frame(3840, 2160).also { thirdRenderer.onFrame(it); it.release() }
    receiver.close()
    thirdRenderer.onFrameResolutionChanged(3840, 2160, 90)
    val afterClose = frame(3840, 2160)
    thirdRenderer.onFrame(afterClose)
    verify(afterClose.buffer.references == 1, "Released renderer retained a late decoder frame")
    afterClose.release()
    lateRendered(null); third.observer.onIceConnectionChange(PeerConnection.IceConnectionState.FAILED)
    FixtureMain.drain()
    verify(third.disposed && thirdRenderer.released && PeerConnectionFactory.factories.all { it.disposed }
        && EglBase.instances.all { it.released }, "Close leaked peer/factory/EGL resources")
    verify(JavaAudioDeviceModule.instances.all { it.microphoneMuted && it.speakerMuted && it.released }, "Audio boundary was not muted/released")
    verify(!readiness.last() && errors.isEmpty(), "Late close callbacks revived readiness or showed an error")
    verify(thirdRenderer.actualHolder.requestedSizes == sizesBeforeClose && buffers.all { it.references == 0 },
        "Late UI resize after close recreated the surface or leaked a decoded frame")
    offer(3)
    verify(PeerConnectionFactory.peers.size == 3, "Closed receiver accepted a new offer")

    val boundedErrors = mutableListOf<String>()
    val bounded = NativeComputerVideoReceiver(Context(), { _, _ -> }, {}, boundedErrors::add)
    repeat(129) { bounded.receive("candidate", JSONObject().put("epoch", 1).put("candidate", "private-fixture-$it")
        .put("sdpMid", "video").put("sdpMLineIndex", 0)) }
    verify(boundedErrors.size == 1 && !boundedErrors.single().contains("private-fixture"), "ICE queue was unbounded or leaked candidate details")
    bounded.close()

    val epochReceipts = mutableListOf<Pair<Long, Long>>()
    val receiptReceiver = NativeComputerVideoReceiver(Context(), { _, _ -> }, {}, errors::add,
        { epoch, id -> epochReceipts += epoch to id })
    fun receiptOffer(epoch: Long) = receiptReceiver.receive("offer", JSONObject().put("epoch", epoch)
        .put("type", "offer").put("sdp", "receipt-fixture"))
    receiptOffer(1)
    val receiptFirst = PeerConnectionFactory.peers.last()
    remoteReady(receiptFirst)
    receiptReceiver.setPagePresentation(true, active = true, presentationId = 10)
    val oldReceiptFrame = receiptFirst.video.sinks.single().firstFrameListeners.last()
    receiptOffer(2)
    receiptReceiver.setPagePresentation(true, active = true, presentationId = 11)
    val receiptSecond = PeerConnectionFactory.peers.last()
    remoteReady(receiptSecond)
    oldReceiptFrame(null); FixtureMain.drain()
    verify(epochReceipts.isEmpty(), "A disposed peer confirmed the replacement page stream")
    receiptSecond.video.sinks.single().renderFrame(); FixtureMain.drain()
    verify(epochReceipts == listOf(2L to 11L), "New peer did not confirm only its own page stream")
    receiptReceiver.reset()
    receiptOffer(1)
    val receiptNewSession = PeerConnectionFactory.peers.last()
    remoteReady(receiptNewSession)
    receiptNewSession.video.sinks.single().renderFrame(); FixtureMain.drain()
    verify(epochReceipts == listOf(2L to 11L), "Reset carried a page receipt into a new display session")
    receiptReceiver.setPagePresentation(true, active = true, presentationId = 12)
    val lateReceiptFrame = receiptNewSession.video.sinks.single().firstFrameListeners.last()
    receiptReceiver.close()
    lateReceiptFrame(null); FixtureMain.drain()
    verify(epochReceipts == listOf(2L to 11L), "A closed receiver confirmed a stale page frame")
    println("NativeComputerVideoReceiver passed ($assertions assertions); real receiver with native/UI boundaries, no GPU/network claims.")
}
