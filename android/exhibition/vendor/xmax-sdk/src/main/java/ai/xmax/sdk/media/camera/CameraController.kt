package ai.xmax.sdk.media.camera

import ai.xmax.sdk.CameraPosition
import ai.xmax.sdk.RealtimeCameraDevice
import ai.xmax.sdk.RealtimeCameraCaptureFormat
import ai.xmax.sdk.RealtimeCameraCaptureInfo
import ai.xmax.sdk.MediaServicing
import ai.xmax.sdk.RealtimeCameraPreviewReadyListener
import ai.xmax.sdk.RealtimeMediaStream
import ai.xmax.sdk.RealtimeVideoFormat
import ai.xmax.sdk.RealtimeVideoTrack
import ai.xmax.sdk.XmaxError
import ai.xmax.sdk.XmaxErrorCode
import ai.xmax.sdk.XmaxLogger
import ai.xmax.sdk.foundation.rtc.CameraFrameGeometry
import ai.xmax.sdk.cleanupAfterFailure
import ai.xmax.sdk.cleanupResources
import ai.xmax.sdk.foundation.permissions.PermissionManaging
import ai.xmax.sdk.foundation.rtc.RtcManaging
import ai.xmax.sdk.render.video.VideoRenderBinding
import ai.xmax.sdk.render.video.VideoRenderRegistry
import ai.xmax.sdk.stream.StreamID
import android.content.Context
import androidx.compose.ui.unit.IntSize
import kotlin.math.abs
import kotlin.math.ln

/**
 * 协调相机权限、RTC 内部采集和本地预览资源。
 */
internal class CameraController(
    private val rtcManager: RtcManaging,
    private val permissionManager: PermissionManaging,
    private val mediaService: MediaServicing,
    private val errorListener: (XmaxError) -> Unit = {},
) {
    constructor(
        context: Context,
        rtcManager: RtcManaging,
        mediaService: MediaServicing = ai.xmax.sdk.service.media.MediaService(),
        errorListener: (XmaxError) -> Unit = {},
    ) : this(
        rtcManager = rtcManager,
        permissionManager = ai.xmax.sdk.foundation.permissions.PermissionManager(context),
        mediaService = mediaService,
        errorListener = errorListener,
    )

    private val stateLock = Any()
    private var activeTrack: RealtimeVideoTrack? = null
    private var storedUseMicrophone = false
    private var isMicrophoneCapturing = false
    private var connectionFormatFrozen = false

    val currentTrack: RealtimeVideoTrack?
        get() = synchronized(stateLock) { activeTrack }

    val useMicrophone: Boolean
        get() = synchronized(stateLock) { activeTrack != null && storedUseMicrophone }

    fun captureInfo(): RealtimeCameraCaptureInfo? {
        if (currentTrack == null) return null
        return rtcManager.cameraFrameGeometry?.let {
            RealtimeCameraCaptureInfo(it.width, it.height, it.rotationDegrees)
        }
    }

    fun setPreviewReadyListener(listener: RealtimeCameraPreviewReadyListener?) {
        rtcManager.setCameraPreviewReadyListener(if (listener == null) null else RealtimeCameraPreviewReadyListener {
            try {
                synchronized(stateLock) {
                    val track = activeTrack ?: return@RealtimeCameraPreviewReadyListener
                    val geometry = rtcManager.cameraFrameGeometry ?: return@RealtimeCameraPreviewReadyListener
                    if (!connectionFormatFrozen) applyGeometry(track, geometry)
                }
                listener.onCameraPreviewReady()
            } catch (error: Throwable) { errorListener(XmaxError.from(error)) }
        })
    }

    /** Resolve once more before encoding, then pin start/change_condition to that same format. */
    suspend fun prepareConnectionVideoFormat(): RealtimeVideoFormat {
        val track = currentTrack ?: throw XmaxError(XmaxErrorCode.INVALID_CONFIGURATION, "Camera capture is not active")
        val geometry = rtcManager.awaitCameraFrameGeometry()
        return synchronized(stateLock) {
            if (activeTrack !== track) throw XmaxError(XmaxErrorCode.INVALID_CONFIGURATION, "Camera capture changed")
            applyGeometry(track, geometry)
            connectionFormatFrozen = true
            val format = checkNotNull(track.videoFormat)
            XmaxLogger.realtime.info(message = {
                "Camera input: raw=${geometry.width}x${geometry.height}, rotation=${geometry.rotationDegrees}, model=${format.width}x${format.height}, fps=${format.fps}"
            })
            checkNotNull(track.videoFormat)
        }
    }

    private fun applyGeometry(track: RealtimeVideoTrack, geometry: CameraFrameGeometry) {
        val actual = IntSize(geometry.displayWidth, geometry.displayHeight)
        // 1.0.9 models accept fixed generation buckets. Driver-negotiated capture
        // remains independent; select the bucket closest to its corrected aspect.
        val aspect = actual.width.toDouble() / actual.height
        val input = mediaService.model.resolutionBuckets.minByOrNull {
            abs(ln(aspect / (it.width.toDouble() / it.height)))
        } ?: actual
        val size = mediaService.resolveModelInputSize(input)
        track.updateVideoFormat(checkNotNull(track.videoFormat).copy(width = size.width, height = size.height).also(RealtimeVideoFormat::validate))
    }

    suspend fun enumerateCameraDevices(): List<RealtimeCameraDevice> {
        permissionManager.ensureCameraPermission()
        return rtcManager.enumerateCameraDevices()
    }

    suspend fun createLocalCameraStream(
        videoFormat: RealtimeVideoFormat,
        position: CameraPosition,
        useMicrophone: Boolean = false,
        cameraDeviceId: String? = null,
        cameraRotationDegrees: Int = 0,
        captureFormat: RealtimeCameraCaptureFormat? = null,
    ): RealtimeMediaStream {
        captureFormat?.validate()
        if (cameraRotationDegrees !in listOf(0, 90, 180, 270)) {
            throw XmaxError(
                code = XmaxErrorCode.INVALID_CONFIGURATION,
                message = "Camera rotation must be 0, 90, 180, or 270 degrees",
            )
        }
        if (currentTrack != null) {
            throw XmaxError(
                code = XmaxErrorCode.INVALID_CONFIGURATION,
                message = "Stop the current local camera stream before creating another one",
            )
        }

        permissionManager.ensureCameraPermission()
        val selectedDevice = cameraDeviceId?.let { id ->
            rtcManager.enumerateCameraDevices().firstOrNull { it.id == id && id.isNotBlank() }
                ?: throw XmaxError(
                    code = XmaxErrorCode.INVALID_CONFIGURATION,
                    message = "Selected camera is unavailable; enumerate camera devices again",
                )
        }
        val resolvedFormat = resolveVideoFormat(videoFormat)
        val track = RealtimeVideoTrack(
            id = LOCAL_VIDEO_TRACK_ID,
            videoFormat = resolvedFormat,
            position = if (selectedDevice != null) selectedDevice.position else position,
        )
        try {
            if (useMicrophone) permissionManager.ensureMicrophonePermission()
            if (selectedDevice != null) {
                rtcManager.selectCameraDevice(selectedDevice.id, selectedDevice.position)
            } else {
                rtcManager.switchCamera(position)
            }
            rtcManager.setVideoCaptureRotation(cameraRotationDegrees)
            rtcManager.startVideoCapture(
                width = captureFormat?.width ?: resolvedFormat.width,
                height = captureFormat?.height ?: resolvedFormat.height,
                frameRate = captureFormat?.fps ?: resolvedFormat.fps,
            )
            VideoRenderRegistry.register(
                track,
                VideoRenderBinding(
                    attachHandler = { view, contentMode ->
                        try {
                            view.prepareLocalCameraRendering()
                            rtcManager.bindLocalVideo(view.rtcRenderView, contentMode)
                        } catch (error: Throwable) {
                            errorListener(XmaxError.from(error))
                            throw error
                        }
                    },
                    detachHandler = { rtcManager.unbindLocalVideo() },
                ),
            )
            synchronized(stateLock) {
                activeTrack = track
                connectionFormatFrozen = false
                storedUseMicrophone = useMicrophone
            }
            return RealtimeMediaStream(StreamID.LOCAL.value, track)
        } catch (error: Throwable) {
            cleanupAfterFailure(error,
                { VideoRenderRegistry.unregister(track) },
                { rtcManager.stopVideoCapture() },
            )
            throw XmaxError.from(error)
        }
    }

    fun startMicrophoneCapture() {
        val shouldStart = synchronized(stateLock) {
            if (activeTrack == null || !storedUseMicrophone || isMicrophoneCapturing) {
                false
            } else {
                isMicrophoneCapturing = true
                true
            }
        }
        if (shouldStart) rtcManager.startAudioCapture()
    }

    fun stopMicrophoneCapture() {
        if (!synchronized(stateLock) { isMicrophoneCapturing }) return
        rtcManager.stopAudioCapture()
        synchronized(stateLock) { isMicrophoneCapturing = false }
    }

    suspend fun stopLocalCameraStream() {
        val track = synchronized(stateLock) {
            activeTrack.also {
                activeTrack = null
                connectionFormatFrozen = false
                storedUseMicrophone = false
            }
        }
        try {
            cleanupResources(
                { stopMicrophoneCapture() },
                { track?.let(VideoRenderRegistry::unregister) },
                { if (track != null) rtcManager.unbindLocalVideo() },
                { rtcManager.stopVideoCapture() },
            )
        } finally {
            synchronized(stateLock) { isMicrophoneCapturing = false }
        }
    }

    suspend fun switchCamera(): RealtimeMediaStream {
        val track = currentTrack
        val position = track?.position
        if (track == null || track.videoFormat == null || position == null) {
            throw XmaxError(
                code = XmaxErrorCode.RTC_ERROR,
                message = "Local camera preview is not started",
            )
        }

        val nextPosition = when (position) {
            CameraPosition.FRONT -> CameraPosition.BACK
            CameraPosition.BACK -> CameraPosition.FRONT
        }
        return try {
            rtcManager.switchCamera(nextPosition)
            track.updatePosition(nextPosition)
            RealtimeMediaStream(StreamID.LOCAL.value, track)
        } catch (error: Throwable) {
            throw XmaxError.from(error)
        }
    }

    private fun resolveVideoFormat(videoFormat: RealtimeVideoFormat): RealtimeVideoFormat {
        videoFormat.validate()
        val size = mediaService.resolveModelInputSize(
            IntSize(videoFormat.width, videoFormat.height),
        )
        return videoFormat.copy(width = size.width, height = size.height)
            .also(RealtimeVideoFormat::validate)
    }

    private companion object {
        const val LOCAL_VIDEO_TRACK_ID = "video0"
    }
}
