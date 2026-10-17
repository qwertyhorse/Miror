package ai.openbuy.exhibition

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.SurfaceHolder
import android.view.View
import android.widget.FrameLayout
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RendererCommon
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoCodecInfo
import org.webrtc.VideoEncoder
import org.webrtc.VideoEncoderFactory
import org.webrtc.VideoFrame
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.floor
import kotlin.math.sqrt

/** LAN video-only answerer. Construct on Main; methods are thread-safe and callbacks run on Main.
 * Each display session must call reset before reusing epochs. No local media source is created. */
internal class NativeComputerVideoReceiver(
    context: Context,
    private val onSignal: (String, JSONObject) -> Unit,
    private val onReady: (Boolean) -> Unit,
    private val onError: (String) -> Unit,
    private val onPageRendered: (Long, Long) -> Unit = { _, _ -> },
) : AutoCloseable {
    private val applicationContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val container = FrameLayout(context)
    val view: View get() = container
    private var closed = false
    private var ready = false
    private var mirrored = false
    private var rotation = 0
    private var pagePresentation = false
    private var pageActive = true
    private var pagePresentationId: Long? = null
    private var presentationRevision = 0L
    private var generation = 0L
    private var highestEpoch = 0L
    private var egl: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    private var active: Connection? = null
    private val pendingIce = ArrayDeque<PendingIce>()

    private class Connection(val generation: Long, val epoch: Long) {
        var peer: PeerConnection? = null
        var remoteDescriptionSet = false
        var videoTransceiver: RtpTransceiver? = null
        var track: VideoTrack? = null
        var renderer: BoundedVideoRenderer? = null
        var receiverId: String? = null
        var renderWaitRevision: Long? = null
    }
    private data class PendingIce(val epoch: Long, val candidate: IceCandidate)

    fun receive(kind: String, payload: JSONObject) {
        // Snapshot caller-owned JSON before dispatching; bound untrusted signaling, never log SDP/ICE.
        val json = payload.toString()
        if (json.length > MAX_SIGNAL_CHARS) { dispatch { reportError("电脑视频信令过大") }; return }
        dispatch {
            if (closed) return@dispatch
            try {
                val signal = JSONObject(json)
                when (kind) {
                    "offer" -> receiveOffer(signal)
                    "candidate" -> receiveCandidate(signal)
                }
            } catch (_: Exception) {
                reportError("电脑视频信令无效")
            } catch (_: LinkageError) {
                reportError("视频接收组件未就绪")
            }
        }
    }

    /** Keep the stable view and decoder factory, but invalidate every old peer and frame callback. */
    fun reset() = dispatch {
        if (!closed) {
            highestEpoch = 0
            pagePresentation = false; pageActive = true; pagePresentationId = null; presentationRevision++
            pendingIce.clear()
            releaseConnection()
        }
    }

    fun setMirrored(value: Boolean) = dispatch {
        if (!closed) {
            mirrored = value
            active?.renderer?.setMirror(value)
        }
    }

    fun setPagePresentation(value: Boolean, active: Boolean = true, presentationId: Long? = null) = dispatch {
        if (!closed) {
            val id = presentationId?.takeIf { value && it in 0..9_007_199_254_740_991L }
            val changed = pagePresentation != value || pageActive != active || pagePresentationId != id
            if (changed) presentationRevision++
            val awaitingFreshFrame = changed || (value && !active)
            pagePresentation = value
            pageActive = active
            pagePresentationId = id
            this.active?.renderer?.setScalingType(if (value) RendererCommon.ScalingType.SCALE_ASPECT_FIT
                else RendererCommon.ScalingType.SCALE_ASPECT_FILL)
            if (awaitingFreshFrame) {
                this.active?.let { connection ->
                    connection.renderer?.let { renderer ->
                        renderer.clearImage()
                        connection.track?.let { awaitRenderedFrame(connection, renderer, it) }
                    }
                }
                publishReady(false)
            }
        }
    }

    fun setRotation(value: Int) {
        require(value == 0 || value == 90 || value == 180 || value == 270) { "Invalid display rotation" }
        dispatch {
            if (!closed) {
                rotation = value
                active?.renderer?.setInputRotation(value)
            }
        }
    }

    override fun close() = dispatch {
        if (!closed) {
            closed = true
            pendingIce.clear()
            releaseConnection()
            factory?.dispose()
            factory = null
            egl?.release()
            egl = null
        }
    }

    private fun receiveOffer(payload: JSONObject) {
        val epoch = readEpoch(payload)
        val sdp = payload.getString("sdp")
        require(payload.optString("type", "offer") == "offer" && sdp.isNotBlank())
        if (epoch <= highestEpoch) return // A duplicate poll or old session must not replace a live peer.
        highestEpoch = epoch
        releaseConnection()
        pendingIce.removeAll { it.epoch != epoch }
        val connection = Connection(generation, epoch)
        active = connection
        try {
            val owner = ensureFactory()
            val configuration = PeerConnection.RTCConfiguration(emptyList()).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
                rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            }
            val peer = checkNotNull(owner.createPeerConnection(configuration, observer(connection)))
            connection.peer = peer
            peer.setAudioPlayout(false)
            peer.setAudioRecording(false)
            peer.setRemoteDescription(object : DescriptionObserver() {
                override fun onSetSuccess() = post(connection) {
                    connection.remoteDescriptionSet = true
                    configureReceiving(connection, owner)
                    val candidates = pendingIce.filter { it.epoch == epoch }
                    pendingIce.clear()
                    candidates.forEach { peer.addIceCandidate(it.candidate) }
                    peer.createAnswer(object : DescriptionObserver() {
                        override fun onCreateSuccess(description: SessionDescription) = post(connection) {
                            peer.setLocalDescription(object : DescriptionObserver() {
                                override fun onSetSuccess() = post(connection) {
                                    onSignal("answer", JSONObject().put("epoch", epoch)
                                        .put("type", "answer").put("sdp", description.description))
                                }
                                override fun onSetFailure(error: String) = fail(connection)
                            }, description)
                        }
                        override fun onCreateFailure(error: String) = fail(connection)
                    }, MediaConstraints())
                }
                override fun onSetFailure(error: String) = fail(connection)
            }, SessionDescription(SessionDescription.Type.OFFER, sdp))
        } catch (_: Exception) {
            reportError("电脑视频连接失败，请重试")
        } catch (_: LinkageError) {
            reportError("视频接收组件未就绪")
        }
    }

    private fun receiveCandidate(payload: JSONObject) {
        val epoch = readEpoch(payload)
        if (epoch < highestEpoch) return
        val value = payload.optString("candidate")
        if (value.isEmpty()) return // Browser end-of-candidates marker.
        require(value.length <= MAX_CANDIDATE_CHARS)
        val mid = payload.opt("sdpMid").takeUnless { it == null || it === JSONObject.NULL }?.toString()
        require(mid == null || mid.length <= 128)
        val index = if (payload.isNull("sdpMLineIndex")) 0 else payload.getInt("sdpMLineIndex")
        require(index in 0..31)
        val candidate = IceCandidate(mid, index, value)
        val current = active
        if (current != null && current.epoch == epoch && current.remoteDescriptionSet) {
            current.peer?.addIceCandidate(candidate)
        } else {
            require(pendingIce.size < MAX_PENDING_ICE)
            pendingIce.addLast(PendingIce(epoch, candidate))
        }
    }

    private fun configureReceiving(connection: Connection, owner: PeerConnectionFactory) {
        val codecs = owner.getRtpReceiverCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO).codecs
            .sortedBy {
                when {
                    isComputerBaselineFormat(it.name, it.parameters) -> 0
                    it.name.equals("H264", ignoreCase = true) -> 1
                    else -> 2
                }
            }
        // getTransceivers disposes its previous wrappers. Read it once and let PeerConnection own
        // those wrappers until cleanup; remove the sink before disposing that PeerConnection.
        val transceivers = checkNotNull(connection.peer).transceivers
        val video = transceivers.firstOrNull { it.mediaType == MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO }
            ?: throw IllegalArgumentException("Missing video")
        transceivers.forEach { transceiver ->
            check(transceiver.setDirection(if (transceiver === video)
                RtpTransceiver.RtpTransceiverDirection.RECV_ONLY else RtpTransceiver.RtpTransceiverDirection.INACTIVE))
            if (transceiver !== video) transceiver.receiver.track()?.setEnabled(false)
        }
        video.setCodecPreferences(codecs)
        connection.videoTransceiver = video
        attachVideo(connection)
    }

    private fun attachVideo(connection: Connection) {
        val receiver = connection.videoTransceiver?.receiver ?: return
        val track = receiver.track() as? VideoTrack ?: return
        if (connection.track === track) return
        releaseVideo(connection)
        val renderer = BoundedVideoRenderer(container.context)
        connection.renderer = renderer
        connection.track = track
        connection.receiverId = receiver.id()
        renderer.init(checkNotNull(egl).eglBaseContext, null)
        renderer.setScalingType(if (pagePresentation) RendererCommon.ScalingType.SCALE_ASPECT_FIT
            else RendererCommon.ScalingType.SCALE_ASPECT_FILL)
        renderer.setEnableHardwareScaler(true)
        renderer.setMirror(mirrored)
        renderer.setInputRotation(rotation)
        // The RendererEvents first-frame event fires before drawing. A zero-scale frame listener
        // runs after EGL drawing/swap, allocates no bitmap, and waits until a surface exists.
        awaitRenderedFrame(connection, renderer, track)
        container.addView(renderer, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT))
        track.setEnabled(true)
        track.addSink(renderer)
    }

    private fun observer(connection: Connection) = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            when (state) {
                PeerConnection.IceConnectionState.FAILED -> fail(connection)
                PeerConnection.IceConnectionState.DISCONNECTED -> post(connection) {
                    publishReady(false)
                    val renderer = connection.renderer
                    renderer?.clearImage()
                    val track = connection.track
                    if (renderer != null && track != null) awaitRenderedFrame(connection, renderer, track)
                }
                PeerConnection.IceConnectionState.CLOSED -> post(connection) {
                    connection.renderer?.clearImage()
                    publishReady(false)
                }
                else -> Unit
            }
        }
        override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
            if (state == PeerConnection.PeerConnectionState.FAILED) fail(connection)
        }
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit
        override fun onIceCandidate(candidate: IceCandidate) = post(connection) {
            onSignal("candidate", JSONObject().put("epoch", connection.epoch)
                .put("candidate", candidate.sdp).put("sdpMid", candidate.sdpMid ?: JSONObject.NULL)
                .put("sdpMLineIndex", candidate.sdpMLineIndex))
        }
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
        override fun onAddStream(stream: MediaStream) = Unit
        override fun onRemoveStream(stream: MediaStream) = Unit
        override fun onRenegotiationNeeded() = Unit // Only the computer initiates offers.
        override fun onDataChannel(channel: DataChannel) {
            main.post { channel.close(); channel.dispose() }
        }
        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) =
            post(connection) { if (connection.remoteDescriptionSet) attachVideo(connection) }
        override fun onTrack(transceiver: RtpTransceiver) =
            post(connection) { if (connection.remoteDescriptionSet) attachVideo(connection) }
        override fun onRemoveTrack(receiver: RtpReceiver) {
            val receiverId = receiver.id()
            post(connection) { if (connection.receiverId == receiverId) releaseVideo(connection) }
        }
    }

    private fun ensureFactory(): PeerConnectionFactory {
        factory?.let { return it }
        synchronized(NativeComputerVideoReceiver::class.java) {
            if (!initialized) {
                PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(applicationContext)
                    .setEnableInternalTracer(false).createInitializationOptions())
                initialized = true
            }
        }
        val graphics = egl ?: EglBase.create().also { egl = it }
        val audio = JavaAudioDeviceModule.builder(applicationContext).createAudioDeviceModule()
        try {
            audio.setMicrophoneMute(true)
            audio.setSpeakerMute(true)
            return PeerConnectionFactory.builder().setAudioDeviceModule(audio)
                .setVideoDecoderFactory(NativeComputerVideoDecoderFactory(graphics.eglBaseContext))
                .setVideoEncoderFactory(object : VideoEncoderFactory {
                    override fun createEncoder(info: VideoCodecInfo): VideoEncoder? = null
                    override fun getSupportedCodecs(): Array<VideoCodecInfo> = emptyArray()
                }).createPeerConnectionFactory().also { factory = it }
        } finally {
            audio.release() // The native factory retained its reference; no recorder/player is started.
        }
    }

    private fun releaseVideo(connection: Connection) {
        val renderer = connection.renderer
        connection.renderer = null
        connection.track?.let { track -> if (renderer != null) track.removeSink(renderer) }
        connection.track = null
        connection.receiverId = null
        connection.renderWaitRevision = null
        renderer?.let { it.clearImage(); it.release(); container.removeView(it) }
        publishReady(false)
    }

    private fun awaitRenderedFrame(connection: Connection, renderer: BoundedVideoRenderer, track: VideoTrack) {
        val revision = presentationRevision
        val presentationId = pagePresentationId
        if (connection.renderWaitRevision == revision) return
        connection.renderWaitRevision = revision
        renderer.addFrameListener({
            post(connection) {
                if (connection.renderer === renderer && connection.track === track &&
                    presentationRevision == revision && connection.renderWaitRevision == revision) {
                    connection.renderWaitRevision = null
                    if (!pagePresentation || pageActive) {
                        publishReady(true)
                        if (pagePresentation && pageActive && presentationId != null &&
                            pagePresentationId == presentationId) onPageRendered(connection.epoch, presentationId)
                    }
                }
            }
        }, 0f)
    }

    private fun releaseConnection() {
        generation++
        val previous = active
        active = null
        if (previous != null) {
            releaseVideo(previous)
            previous.peer?.dispose()
            previous.peer = null
        }
        publishReady(false)
    }

    private fun readEpoch(payload: JSONObject): Long = payload.getLong("epoch").also {
        require(it in 1..9_007_199_254_740_991L)
    }
    private fun publishReady(value: Boolean) {
        if (ready != value) { ready = value; onReady(value) }
    }
    private fun reportError(message: String) {
        if (closed) return
        pendingIce.clear()
        releaseConnection()
        onError(message)
    }
    private fun fail(connection: Connection) = post(connection) { reportError("电脑视频连接失败，请重试") }
    private fun post(connection: Connection, action: () -> Unit) {
        // Always unwind the native callback before disposing/creating native peer resources.
        main.post {
            if (!closed && active === connection && generation == connection.generation) {
                try { action() } catch (_: Exception) { reportError("电脑视频连接失败，请重试") }
            }
        }
    }
    private fun dispatch(action: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) action() else main.post(action)
    }
    private open class DescriptionObserver : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) = Unit
        override fun onSetSuccess() = Unit
        override fun onCreateFailure(error: String) = Unit
        override fun onSetFailure(error: String) = Unit
    }

    companion object {
        private var initialized = false
        private const val MAX_SIGNAL_CHARS = 262_144
        private const val MAX_CANDIDATE_CHARS = 4096
        private const val MAX_PENDING_ICE = 128
    }
}

private const val COMPUTER_VIDEO_PREVIEW_PIXELS = 1920L * 1080
private const val COMPUTER_VIDEO_MAX_PIXELS = 3840L * 2160

/** Keep the full-size window hole, but allocate only the decoded input's bounded pixel budget.
 * Before the first frame, even a 4K screen uses at most a 1080p buffer. */
private class BoundedVideoRenderer(context: Context) : SurfaceViewRenderer(context) {
    private var boundedHolder: FrameBoundedHolder? = null
    private val main = Handler(Looper.getMainLooper())
    private data class FrameGeometry(val width: Int, val height: Int, val rotation: Int)
    private val latestGeometry = AtomicReference<FrameGeometry?>()
    private val resizeQueued = AtomicBoolean(false)
    private var pixelBudget = COMPUTER_VIDEO_PREVIEW_PIXELS // Main-thread holder state.
    @Volatile private var renderReleased = false
    @Volatile private var inputRotation = 0

    fun setInputRotation(value: Int) { inputRotation = value }

    override fun onFrame(frame: VideoFrame) {
        if (renderReleased) return
        val extraRotation = inputRotation
        if (extraRotation == 0) super.onFrame(frame)
        else {
            // VideoFrame's constructor borrows its buffer without retaining it. Own one reference
            // for this metadata wrapper; SurfaceViewRenderer independently retains queued frames.
            frame.buffer.retain()
            val rotated = VideoFrame(frame.buffer, (frame.rotation + extraRotation) % 360, frame.timestampNs)
            try { super.onFrame(rotated) } finally { rotated.release() }
        }
    }

    override fun onFrameResolutionChanged(videoWidth: Int, videoHeight: Int, rotation: Int) {
        if (renderReleased || videoWidth <= 0 || videoHeight <= 0) return
        // WebRTC reports the dimensions after our rotation wrapper. Move its geometry update
        // and our pixel budget together: resizing here before super updates the geometry would
        // allocate an intermediate surface using the previous frame's requested dimensions.
        // Only retain metadata; bursts collapse to the latest size without retaining video frames.
        latestGeometry.set(FrameGeometry(videoWidth, videoHeight, rotation))
        if (resizeQueued.compareAndSet(false, true)) main.post {
            resizeQueued.set(false)
            if (!renderReleased) latestGeometry.getAndSet(null)?.let { geometry ->
                pixelBudget = (geometry.width.toLong() * geometry.height)
                    .coerceIn(1, COMPUTER_VIDEO_MAX_PIXELS)
                // On Main this updates WebRTC's geometry and holder synchronously.
                super.onFrameResolutionChanged(geometry.width, geometry.height, geometry.rotation)
                // Its requested size can stay unchanged even when the pixel budget changes.
                boundedHolder?.applySize()
            }
        }
    }

    override fun release() {
        renderReleased = true
        latestGeometry.set(null)
        super.release()
    }

    override fun getHolder(): SurfaceHolder {
        boundedHolder?.let { return it }
        val actual = super.getHolder()
        return FrameBoundedHolder(actual).also { boundedHolder = it }
    }

    private inner class FrameBoundedHolder(private val actual: SurfaceHolder) : SurfaceHolder by actual {
        private var requestedWidth = 0
        private var requestedHeight = 0
        private var fixedWidth = 0
        private var fixedHeight = 0
        override fun setFixedSize(width: Int, height: Int) {
            requestedWidth = width; requestedHeight = height
            applySize()
        }
        fun applySize() {
            if (renderReleased || requestedWidth <= 0 || requestedHeight <= 0) return
            val size = computerVideoSurfaceSize(requestedWidth, requestedHeight, pixelBudget)
            if (size.first != fixedWidth || size.second != fixedHeight) {
                fixedWidth = size.first; fixedHeight = size.second
                actual.setFixedSize(fixedWidth, fixedHeight)
            }
        }
        override fun setSizeFromLayout() = setFixedSize(this@BoundedVideoRenderer.width,
            this@BoundedVideoRenderer.height)
    }
}

internal fun computerVideoSurfaceSize(width: Int, height: Int, pixelBudget: Long = COMPUTER_VIDEO_MAX_PIXELS): Pair<Int, Int> {
    val w = width.coerceAtLeast(1)
    val h = height.coerceAtLeast(1)
    val pixels = w.toLong() * h
    val budget = pixelBudget.coerceIn(1, COMPUTER_VIDEO_MAX_PIXELS)
    val scale = minOf(1.0, sqrt(budget.toDouble() / pixels), 3840.0 / maxOf(w, h), 2160.0 / minOf(w, h))
    val scaledWidth = floor(w * scale).toInt().coerceIn(1, budget.toInt())
    val scaledHeight = floor(h * scale).toInt().coerceIn(1, (budget / scaledWidth).toInt())
    return scaledWidth to scaledHeight
}
