package ai.xmax.sdk

import android.content.Context

// These are SDK boundary doubles. Public camera/video formats and model definitions are
// compiled from the SDK sources; no capture selection or frame-rate policy lives here.
enum class XmaxEnvironment { CHINA, GLOBAL }
data class XmaxConfiguration(val token: String, val environment: XmaxEnvironment)
enum class XmaxErrorCode { INVALID_CONFIGURATION }
class XmaxError(val code: XmaxErrorCode, message: String) : RuntimeException(message)
class RealtimeContext(val prompt: String, val referencePath: String?)
class RealtimeMediaStream(val videoTrack: Any = Any())
class XmaxRealtimeVideoView {
    var videoContentMode = VideoContentMode.FIT
    var isInteractionEnabled = false
    var localTrack: Any? = null
    var remoteTrack: Any? = null
}

class XmaxClient(
    @Suppress("UNUSED_PARAMETER") context: Context,
    private val configuration: XmaxConfiguration,
) {
    fun createRealtimeManager(options: RealtimeConfiguration): XmaxRealtimeManaging =
        FixtureRealtimeManager(configuration, options).also { managers += it }

    companion object {
        val managers = mutableListOf<FixtureRealtimeManager>()
        var cameraDevices = emptyList<RealtimeCameraDevice>()
    }
}

interface XmaxRealtimeManaging {
    val currentState: RealtimeState
    suspend fun enumerateCameraDevices(): List<RealtimeCameraDevice>
    suspend fun createLocalCameraStream(
        videoFormat: RealtimeVideoFormat,
        position: CameraPosition,
        useMicrophone: Boolean,
        cameraDeviceId: String?,
        cameraRotationDegrees: Int,
        captureFormat: RealtimeCameraCaptureFormat?,
    ): RealtimeMediaStream
    suspend fun cameraCaptureInfo(): RealtimeCameraCaptureInfo?
    suspend fun createLocalImageStream(image: ByteArray): RealtimeMediaStream
    suspend fun connect(source: RealtimeMediaStream): RealtimeMediaStream
    suspend fun startGeneration(context: RealtimeContext)
    suspend fun setStateListener(listener: RealtimeStateListener?)
    suspend fun setLocalVideoFrameListener(listener: RealtimeLocalVideoFrameListener?)
    suspend fun setRemoteVideoFrameListener(listener: RealtimeVideoFrameListener?)
    suspend fun close()
}

data class FixtureCameraRequest(
    val videoFormat: RealtimeVideoFormat,
    val captureFormat: RealtimeCameraCaptureFormat?,
    val position: CameraPosition,
    val useMicrophone: Boolean,
    val deviceId: String?,
    val rotation: Int,
)

class FixtureRealtimeManager(val configuration: XmaxConfiguration, val options: RealtimeConfiguration) : XmaxRealtimeManaging {
    override var currentState = RealtimeState(RealtimeConnectionState.IDLE)
    val cameraRequests = mutableListOf<FixtureCameraRequest>()
    val localStream = RealtimeMediaStream()
    val remoteStream = RealtimeMediaStream()
    var connectedSource: RealtimeMediaStream? = null
    var closed = false
    private var stateListener: RealtimeStateListener? = null

    override suspend fun enumerateCameraDevices() = XmaxClient.cameraDevices
    override suspend fun createLocalCameraStream(
        videoFormat: RealtimeVideoFormat,
        position: CameraPosition,
        useMicrophone: Boolean,
        cameraDeviceId: String?,
        cameraRotationDegrees: Int,
        captureFormat: RealtimeCameraCaptureFormat?,
    ): RealtimeMediaStream {
        videoFormat.validate()
        captureFormat?.validate()
        cameraRequests += FixtureCameraRequest(videoFormat, captureFormat, position, useMicrophone,
            cameraDeviceId, cameraRotationDegrees)
        currentState = RealtimeState(RealtimeConnectionState.READY)
        stateListener?.onStateChanged(currentState)
        return localStream
    }
    override suspend fun cameraCaptureInfo(): RealtimeCameraCaptureInfo? = null
    override suspend fun createLocalImageStream(image: ByteArray): RealtimeMediaStream =
        error("The camera fixture must not create an image stream")
    override suspend fun connect(source: RealtimeMediaStream): RealtimeMediaStream {
        connectedSource = source
        currentState = RealtimeState(RealtimeConnectionState.CONNECTED, sessionId = "fixture-session")
        stateListener?.onStateChanged(currentState)
        return remoteStream
    }
    override suspend fun startGeneration(context: RealtimeContext) = Unit
    override suspend fun setStateListener(listener: RealtimeStateListener?) { stateListener = listener }
    override suspend fun setLocalVideoFrameListener(listener: RealtimeLocalVideoFrameListener?) = Unit
    override suspend fun setRemoteVideoFrameListener(listener: RealtimeVideoFrameListener?) = Unit
    override suspend fun close() { closed = true }
}
