package org.webrtc

import android.content.Context
import android.media.MediaCodecInfo
import android.os.FixtureMain
import android.os.Looper
import android.view.FixtureHolder
import android.view.SurfaceHolder
import android.view.View
import org.webrtc.audio.JavaAudioDeviceModule

// I/O boundary doubles only. The production receiver owns signaling, epochs, buffering,
// transceiver selection, sink lifecycle and render-size calculations under test.
class EglBase {
    class Context
    val eglBaseContext = Context()
    var released = false
    fun release() { released = true }
    companion object {
        val instances = mutableListOf<EglBase>()
        fun create() = EglBase().also { instances += it }
    }
}
interface VideoDecoder
interface VideoDecoderFactory {
    fun createDecoder(info: VideoCodecInfo): VideoDecoder?
    fun getSupportedCodecs(): Array<VideoCodecInfo>
}
class DefaultVideoDecoderFactory(val context: EglBase.Context) : VideoDecoderFactory {
    override fun createDecoder(info: VideoCodecInfo): VideoDecoder? = null
    override fun getSupportedCodecs() = arrayOf(VideoCodecInfo("VP8"),
        VideoCodecInfo("H264", mapOf("profile-level-id" to "42e01f", "packetization-mode" to "1")))
}
fun interface Predicate<T> { fun test(value: T): Boolean }
class HardwareVideoDecoderFactory(val context: EglBase.Context, val allowed: Predicate<MediaCodecInfo>) : VideoDecoderFactory {
    override fun createDecoder(info: VideoCodecInfo): VideoDecoder? = null
    override fun getSupportedCodecs() = if (candidates.any { it.hardware && allowed.test(it) })
        arrayOf(VideoCodecInfo("H264")) else emptyArray()
    companion object { var candidates = emptyList<MediaCodecInfo>() }
}
data class VideoCodecInfo(val name: String = "H264", val params: Map<String, String> = emptyMap(),
    val scalabilityModes: List<String> = emptyList())
interface VideoEncoder
interface VideoEncoderFactory {
    fun createEncoder(info: VideoCodecInfo): VideoEncoder?
    fun getSupportedCodecs(): Array<VideoCodecInfo>
}
class MediaConstraints
open class MediaStreamTrack {
    enum class MediaType { MEDIA_TYPE_VIDEO, MEDIA_TYPE_AUDIO }
    @JvmField var enabled = true
    fun setEnabled(value: Boolean): Boolean { enabled = value; return true }
}
class VideoTrack : MediaStreamTrack() {
    val sinks = mutableListOf<SurfaceViewRenderer>()
    fun addSink(sink: SurfaceViewRenderer) { sinks += sink }
    fun removeSink(sink: SurfaceViewRenderer) { check(sinks.remove(sink)) }
}
class FixtureVideoBuffer(val width: Int, val height: Int) {
    var references = 1
    var retainCalls = 0
    var releaseCalls = 0
    fun retain() { check(references > 0); references++; retainCalls++ }
    fun release() { check(references > 0); references--; releaseCalls++ }
}
class VideoFrame(val buffer: FixtureVideoBuffer, val rotation: Int, val timestampNs: Long) {
    val rotatedWidth get() = if (rotation % 180 == 0) buffer.width else buffer.height
    val rotatedHeight get() = if (rotation % 180 == 0) buffer.height else buffer.width
    fun retain() = buffer.retain()
    fun release() = buffer.release()
}
class MediaStream
class DataChannel { fun close() = Unit; fun dispose() = Unit }
data class IceCandidate(val sdpMid: String?, val sdpMLineIndex: Int, val sdp: String)
class SessionDescription(val type: Type, val description: String) { enum class Type { OFFER, ANSWER } }
interface SdpObserver {
    fun onCreateSuccess(description: SessionDescription)
    fun onSetSuccess()
    fun onCreateFailure(error: String)
    fun onSetFailure(error: String)
}
class RtpReceiver(private val id: String, private val track: MediaStreamTrack) {
    fun id() = id
    fun track() = track
}
class CodecCapability(val name: String, val parameters: Map<String, String> = emptyMap())
class RtpCapabilities(val codecs: List<CodecCapability>)
class RtpTransceiver(val mediaType: MediaStreamTrack.MediaType, val receiver: RtpReceiver) {
    enum class RtpTransceiverDirection { RECV_ONLY, INACTIVE }
    var selectedDirection: RtpTransceiverDirection? = null
    var codecs = emptyList<CodecCapability>()
    fun setDirection(value: RtpTransceiverDirection): Boolean { selectedDirection = value; return true }
    fun setCodecPreferences(value: List<CodecCapability>) { codecs = value }
}
class PeerConnection(val configuration: RTCConfiguration, val observer: Observer) {
    enum class SdpSemantics { UNIFIED_PLAN }
    enum class BundlePolicy { MAXBUNDLE }
    enum class RtcpMuxPolicy { REQUIRE }
    enum class SignalingState { STABLE }
    enum class IceConnectionState { NEW, CONNECTED, DISCONNECTED, CLOSED, FAILED }
    enum class PeerConnectionState { NEW, CONNECTED, FAILED }
    enum class IceGatheringState { NEW }
    class RTCConfiguration(val iceServers: List<Any>) {
        var sdpSemantics: SdpSemantics? = null
        var bundlePolicy: BundlePolicy? = null
        var rtcpMuxPolicy: RtcpMuxPolicy? = null
    }
    interface Observer {
        fun onSignalingChange(state: SignalingState)
        fun onIceConnectionChange(state: IceConnectionState)
        fun onConnectionChange(state: PeerConnectionState) {}
        fun onIceConnectionReceivingChange(receiving: Boolean)
        fun onIceGatheringChange(state: IceGatheringState)
        fun onIceCandidate(candidate: IceCandidate)
        fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>)
        fun onAddStream(stream: MediaStream)
        fun onRemoveStream(stream: MediaStream)
        fun onDataChannel(channel: DataChannel)
        fun onRenegotiationNeeded()
        fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {}
        fun onTrack(transceiver: RtpTransceiver) {}
        fun onRemoveTrack(receiver: RtpReceiver) {}
    }
    val video = VideoTrack()
    val audio = MediaStreamTrack()
    val transceivers = listOf(
        RtpTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO, RtpReceiver("audio", audio)),
        RtpTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO, RtpReceiver("video", video)),
    )
    var remoteObserver: SdpObserver? = null
    var answerObserver: SdpObserver? = null
    var localObserver: SdpObserver? = null
    var disposed = false
    @JvmField var audioPlayout = true
    @JvmField var audioRecording = true
    val candidates = mutableListOf<IceCandidate>()
    fun setAudioPlayout(value: Boolean) { audioPlayout = value }
    fun setAudioRecording(value: Boolean) { audioRecording = value }
    fun setRemoteDescription(observer: SdpObserver, description: SessionDescription) { remoteObserver = observer }
    fun createAnswer(observer: SdpObserver, constraints: MediaConstraints) { answerObserver = observer }
    fun setLocalDescription(observer: SdpObserver, description: SessionDescription) { localObserver = observer }
    fun addIceCandidate(candidate: IceCandidate): Boolean { candidates += candidate; return true }
    fun dispose() { check(video.sinks.isEmpty()) { "Disposed peer before removing sink" }; disposed = true }
}
class PeerConnectionFactory(val decoderFactory: VideoDecoderFactory) {
    var disposed = false
    fun createPeerConnection(config: PeerConnection.RTCConfiguration, observer: PeerConnection.Observer) =
        PeerConnection(config, observer).also { peers += it }
    fun getRtpReceiverCapabilities(type: MediaStreamTrack.MediaType) =
        // Simulate JNI reordering: preference must be derived from parameters, not factory order.
        RtpCapabilities(decoderFactory.getSupportedCodecs().reversed().map { CodecCapability(it.name, it.params) })
    fun dispose() { disposed = true }
    class Builder {
        private lateinit var decoderFactory: VideoDecoderFactory
        fun setAudioDeviceModule(value: JavaAudioDeviceModule) = this
        fun setVideoDecoderFactory(value: VideoDecoderFactory): Builder { decoderFactory = value; return this }
        fun setVideoEncoderFactory(value: VideoEncoderFactory): Builder {
            check(value.getSupportedCodecs().isEmpty() && value.createEncoder(VideoCodecInfo()) == null)
            return this
        }
        fun createPeerConnectionFactory() = PeerConnectionFactory(decoderFactory).also { factories += it }
    }
    class InitializationOptions {
        class Builder {
            fun setEnableInternalTracer(value: Boolean) = this
            fun createInitializationOptions() = InitializationOptions()
        }
        companion object { fun builder(context: Context) = Builder() }
    }
    companion object {
        val peers = mutableListOf<PeerConnection>()
        val factories = mutableListOf<PeerConnectionFactory>()
        fun initialize(options: InitializationOptions) = Unit
        fun builder() = Builder()
    }
}
object RendererCommon { enum class ScalingType { SCALE_ASPECT_FILL, SCALE_ASPECT_FIT } }
open class SurfaceViewRenderer(context: Context) : View(context) {
    val actualHolder = FixtureHolder()
    var released = false
    var mirrored = false
    var scaling = RendererCommon.ScalingType.SCALE_ASPECT_FILL
    var clearCount = 0
    var firstFrameListeners = mutableListOf<(Any?) -> Unit>()
    var lastFrame: VideoFrame? = null
    private var reportedGeometry: Triple<Int, Int, Int>? = null
    private var requestedSurface = 0 to 0
    open fun onFrame(frame: VideoFrame) {
        lastFrame?.release()
        frame.retain()
        lastFrame = frame
        val geometry = Triple(frame.buffer.width, frame.buffer.height, frame.rotation)
        if (reportedGeometry != geometry) {
            reportedGeometry = geometry
            onFrameResolutionChanged(geometry.first, geometry.second, geometry.third)
        }
    }
    open fun onFrameResolutionChanged(videoWidth: Int, videoHeight: Int, rotation: Int) {
        // Match WebRTC 1.3.10: postOrRun updates geometry and hardware-scaler holder together.
        val update = {
            val frameWidth = if (rotation % 180 == 0) videoWidth else videoHeight
            val frameHeight = if (rotation % 180 == 0) videoHeight else videoWidth
            val layoutAspect = width.toFloat() / height
            val frameAspect = frameWidth.toFloat() / frameHeight
            val drawnWidth = if (frameAspect > layoutAspect) (frameHeight * layoutAspect).toInt() else frameWidth
            val drawnHeight = if (frameAspect > layoutAspect) frameHeight else (frameWidth / layoutAspect).toInt()
            val requested = minOf(width, drawnWidth) to minOf(height, drawnHeight)
            if (requested != requestedSurface) {
                requestedSurface = requested
                getHolder().setFixedSize(requested.first, requested.second)
            }
        }
        if (Looper.myLooper() === Looper.getMainLooper()) update() else FixtureMain.post(update)
    }
    init { instances += this }
    open fun getHolder(): SurfaceHolder = actualHolder
    fun init(context: EglBase.Context, events: Any?) { check(events == null) }
    fun setScalingType(type: RendererCommon.ScalingType) { scaling = type }
    fun setEnableHardwareScaler(value: Boolean) { check(value) }
    fun setMirror(value: Boolean) { mirrored = value }
    fun addFrameListener(callback: (Any?) -> Unit, scale: Float) {
        check(scale == 0f) { "Readiness must not copy a bitmap" }
        firstFrameListeners += callback
    }
    fun renderFrame() {
        val callbacks = firstFrameListeners.toList(); firstFrameListeners.clear()
        callbacks.forEach { it(null) }
    }
    fun clearImage() { clearCount++ }
    open fun release() { lastFrame?.release(); lastFrame = null; released = true }
    companion object { val instances = mutableListOf<SurfaceViewRenderer>() }
}
