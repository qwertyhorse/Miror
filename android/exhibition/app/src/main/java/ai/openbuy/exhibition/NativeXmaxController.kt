package ai.openbuy.exhibition

import android.content.Context
import android.os.Handler
import android.os.Looper
import ai.xmax.sdk.CameraPosition
import ai.xmax.sdk.RealtimeCameraCaptureFormat
import ai.xmax.sdk.RealtimeConfiguration
import ai.xmax.sdk.RealtimeConnectionState
import ai.xmax.sdk.RealtimeContext
import ai.xmax.sdk.RealtimeMediaStream
import ai.xmax.sdk.RealtimeLocalVideoFrameListener
import ai.xmax.sdk.RealtimeVideoFrame
import ai.xmax.sdk.RealtimeModel
import ai.xmax.sdk.RealtimeReason
import ai.xmax.sdk.RealtimeVideoFormat
import ai.xmax.sdk.VideoContentMode
import ai.xmax.sdk.XmaxClient
import ai.xmax.sdk.XmaxConfiguration
import ai.xmax.sdk.XmaxEnvironment
import ai.xmax.sdk.XmaxRealtimeManaging
import ai.xmax.sdk.XmaxRealtimeVideoView
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** Owns one native input and one official XMAX connection at a time. */
internal class NativeXmaxController(
    context: Context,
    private val view: XmaxRealtimeVideoView,
) {
    private val applicationContext = context.applicationContext
    private val mutex = Mutex()
    private val main = Handler(Looper.getMainLooper())
    private val epoch = AtomicLong()
    private var manager: XmaxRealtimeManaging? = null
    private var localStream: RealtimeMediaStream? = null
    private var previewPosition: CameraPosition? = null
    private var previewDeviceId: String? = null
    private var previewRequestedId: String? = null
    private var previewRotationDegrees = 0
    private var previewCaptureSelection = NativeCameraCaptureSelection.Automatic
    internal var captureInfo: NativeCameraCaptureInfo? = null
        private set
    private var activeView = view
    private var previewOnly = false
    private var firstFrameDelivered = false
    internal var hasReleaseFailure = false
        private set

    var onFirstFrame: (() -> Unit)? = null
    var onError: ((String) -> Unit)? = null
    internal var onCameraSnapshot: ((NativeCameraSnapshot) -> Unit)? = null
    /** Acquire the ready consumer before SDK copying; its epoch-bound receiver owns the sample. */
    @Volatile var acquireLocalFrameReceiver: (() -> ((NativeGestureFrame) -> Unit)?)? = null
    @Volatile private var gestureSampling = NativeGestureSampling.LOCAL

    fun invalidateGestureSampling() { gestureSampling = gestureSampling.copy() }

    fun configureGestureSampling(settings: NativeGestureSampling) {
        // A distinct snapshot invalidates old samples even when values later return to their previous setting.
        if (gestureSampling != settings) gestureSampling = settings.copy()
    }

    /** Local-only capture: no temporary key request or XMAX session is created. */
    suspend fun preview(
        position: CameraPosition = CameraPosition.BACK,
        cameraDeviceId: String? = null,
        target: XmaxRealtimeVideoView = view,
        cameraRotationDegrees: Int = 0,
        captureSelection: NativeCameraCaptureSelection = NativeCameraCaptureSelection.Automatic,
    ): String =
        withContext(Dispatchers.Main.immediate) {
            mutex.withLock {
                require(cameraRotationDegrees in listOf(0, 90, 180, 270)) { "摄像头方向无效" }
                check(!hasReleaseFailure) { "摄像头释放失败，请重新打开应用" }
                if (previewOnly && previewPosition == position && previewRequestedId == cameraDeviceId &&
                    previewRotationDegrees == cameraRotationDegrees && previewCaptureSelection == captureSelection &&
                    activeView === target && localStream != null)
                    return@withLock checkNotNull(previewDeviceId)
                release()
                activeView = target
                val ownerEpoch = epoch.get()
                // Client construction and createLocalCameraStream do not invoke an HTTP API.
                val next = client("local-preview-only", "cn")
                    .createRealtimeManager(RealtimeConfiguration(RealtimeModel.X2_1_1_PREVIEW_CN))
                manager = next
                previewOnly = true
                previewPosition = position
                previewRequestedId = cameraDeviceId
                previewRotationDegrees = cameraRotationDegrees
                previewCaptureSelection = captureSelection
                try {
                    val ready = observeErrors(next, ownerEpoch)
                    localStream = camera(next, position, cameraDeviceId, cameraRotationDegrees, captureSelection)
                    activeView.videoContentMode = VideoContentMode.FILL
                    activeView.isInteractionEnabled = false
                    activeView.remoteTrack = null
                    activeView.localTrack = localStream?.videoTrack
                    awaitCameraPreview(ready)
                    captureInfo = next.cameraCaptureInfo()?.let { NativeCameraCaptureInfo(it.width, it.height) }
                    checkNotNull(previewDeviceId)
                } catch (error: Throwable) {
                    withContext(NonCancellable) { release() }
                    throw error
                }
            }
        }

    /** Connect and return the provider id; generation starts only after generate(). */
    suspend fun connect(
        token: String,
        region: String,
        model: String,
        position: CameraPosition = CameraPosition.BACK,
        image: ByteArray? = null,
        cameraDeviceId: String? = null,
        cameraRotationDegrees: Int = 0,
        captureSelection: NativeCameraCaptureSelection = NativeCameraCaptureSelection.Automatic,
    ): String = withContext(Dispatchers.Main.immediate) {
        require(NativeXmaxModel.matches(model, region)) { "当前模型与服务区域不匹配，请更新后台" }
        val realtimeModel = if (region == "cn") RealtimeModel.X2_1_1_PREVIEW_CN else RealtimeModel.X2_1_1_PREVIEW_US
        require(cameraRotationDegrees in listOf(0, 90, 180, 270)) { "摄像头方向无效" }
        mutex.withLock {
            check(!hasReleaseFailure) { "摄像头释放失败，请重新打开应用" }
            release()
            val ownerEpoch = epoch.get()
            val next = client(token, region)
                .createRealtimeManager(RealtimeConfiguration(realtimeModel))
            manager = next
            try {
                val ready = observeErrors(next, ownerEpoch)
                val source = if (image != null) {
                    require(image.isNotEmpty() && image.size <= 64 * 1024 * 1024) { "输入图片不可用" }
                    next.createLocalImageStream(image)
                } else {
                    // Preview and model share the same installation correction.
                    camera(next, position, cameraDeviceId, cameraRotationDegrees, captureSelection)
                }
                localStream = source
                activeView.videoContentMode = VideoContentMode.FILL
                activeView.isInteractionEnabled = image != null
                activeView.localTrack = source.videoTrack
                if (image == null) {
                    awaitCameraPreview(ready)
                    captureInfo = next.cameraCaptureInfo()?.let { NativeCameraCaptureInfo(it.width, it.height) }
                }
                val remote = next.connect(source)
                val sessionId = next.currentState.sessionId?.takeIf { it.isNotBlank() }
                    ?: throw IllegalStateException("实时会话未就绪")
                activeView.remoteTrack = remote.videoTrack
                sessionId
            } catch (error: Throwable) {
                withContext(NonCancellable) { release() }
                throw error
            }
        }
    }

    suspend fun generate(prompt: String, refUrl: String? = null) =
        withContext(Dispatchers.Main.immediate) {
            mutex.withLock {
                val active = manager?.takeUnless { previewOnly }
                    ?: throw IllegalStateException("请先连接镜端")
                require(!active.currentState.sessionId.isNullOrBlank()) { "实时会话未就绪" }
                val ownerEpoch = epoch.get()
                // Official 1.0.9 returns only after the current task's postprocessed
                // remote frame arrives and the remote render binding succeeds.
                active.startGeneration(RealtimeContext(prompt, refUrl))
                if (epoch.get() == ownerEpoch && !firstFrameDelivered) {
                    firstFrameDelivered = true
                    onFirstFrame?.invoke()
                }
            }
        }

    /** End the provider session and release native camera/RTC resources. */
    suspend fun disconnect() = withContext(Dispatchers.Main.immediate + NonCancellable) {
        mutex.withLock { release() }
    }

    suspend fun close() = disconnect()

    private fun client(token: String, region: String): XmaxClient {
        require(token.isNotBlank()) { "连接凭证不可用" }
        val environment = when (region) {
            "cn" -> XmaxEnvironment.CHINA
            "global" -> XmaxEnvironment.GLOBAL
            else -> throw IllegalArgumentException("服务区域不可用")
        }
        return XmaxClient(applicationContext, XmaxConfiguration(token, environment))
    }

    /** Uses the same RTC device IDs that are accepted by capture; Camera2 only adds diagnostics. */
    internal suspend fun detectCameras(): NativeCameraSnapshot = withContext(Dispatchers.Main.immediate) {
        mutex.withLock {
            check(!hasReleaseFailure) { "摄像头释放失败，请重新打开应用" }
            val owner = manager ?: client("local-preview-only", "cn")
                .createRealtimeManager(RealtimeConfiguration(RealtimeModel.X2_1_1_PREVIEW_CN)).also { manager = it }
            cameraSnapshot(owner)
        }
    }

    private suspend fun cameraSnapshot(owner: XmaxRealtimeManaging): NativeCameraSnapshot {
        val system = NativeCameraCatalog(applicationContext).snapshot()
        val devices = owner.enumerateCameraDevices().map {
            NativeCameraDevice(it.id, when (it.position) {
                CameraPosition.FRONT -> NativeCameraFacing.FRONT
                CameraPosition.BACK -> NativeCameraFacing.BACK
                null -> NativeCameraFacing.UNKNOWN
            }, it.name)
        }
        return system.mergeRtcDevices(devices).also { onCameraSnapshot?.invoke(it) }
    }

    private suspend fun camera(
        owner: XmaxRealtimeManaging,
        position: CameraPosition,
        cameraDeviceId: String?,
        cameraRotationDegrees: Int,
        captureSelection: NativeCameraCaptureSelection,
    ): RealtimeMediaStream {
        val detected = cameraSnapshot(owner)
        val selection = NativeCameraSelection(cameraDeviceId)
        val selected = selection.resolve(detected.devices)
            ?: throw IllegalStateException(selection.unavailableMessage(detected))
        previewDeviceId = selected.id
        val captureSize = captureSelection.resolve(selected)
        observeLocalFrames(owner, epoch.get())
        return owner.createLocalCameraStream(
            videoFormat = RealtimeVideoFormat(width = 1024, height = 1920, fps = 24),
            position = when (selected.facing) {
                NativeCameraFacing.FRONT -> CameraPosition.FRONT
                NativeCameraFacing.BACK, NativeCameraFacing.EXTERNAL -> CameraPosition.BACK
                NativeCameraFacing.UNKNOWN -> position
            },
            useMicrophone = false,
            cameraDeviceId = selected.id,
            cameraRotationDegrees = cameraRotationDegrees,
            captureFormat = RealtimeCameraCaptureFormat(captureSize.width, captureSize.height,
                NativeCameraCaptureSelection.framesPerSecond(selected, captureSize)),
        )
    }

    private suspend fun observeLocalFrames(owner: XmaxRealtimeManaging, ownerEpoch: Long) {
        if (acquireLocalFrameReceiver == null) { owner.setLocalVideoFrameListener(null); return }
        val inFlight = AtomicBoolean()
        val lastSample = AtomicLong(Long.MIN_VALUE)
        val pendingSampling = AtomicReference<NativeGestureSampling?>()
        val pendingReceiver = AtomicReference<((NativeGestureFrame) -> Unit)?>()
        owner.setLocalVideoFrameListener(object : RealtimeLocalVideoFrameListener {
            override fun shouldCaptureFrame(timestampMs: Long): Boolean {
                if (epoch.get() != ownerEpoch) return false
                val previous = lastSample.get()
                val sampling = gestureSampling
                if (previous != Long.MIN_VALUE && timestampMs - previous < sampling.intervalMs) return false
                if (!inFlight.compareAndSet(false, true)) return false
                val receiver = acquireLocalFrameReceiver?.invoke()
                if (receiver == null) { inFlight.set(false); return false }
                pendingReceiver.set(receiver)
                pendingSampling.set(sampling)
                lastSample.set(timestampMs)
                return true
            }
            override fun onFrameDropped() { pendingReceiver.set(null); pendingSampling.set(null); inFlight.set(false) }
            override fun onFrame(frame: RealtimeVideoFrame, timestampMs: Long) {
                val sampling = pendingSampling.getAndSet(null)
                val receiver = pendingReceiver.getAndSet(null)
                var sample: NativeGestureFrame? = null
                var transferred = false
                try {
                    if (sampling == null || sampling !== gestureSampling || epoch.get() != ownerEpoch || receiver == null) return
                    val owned = NativeGestureFrame(frame.width, frame.height, frame.rotationDegrees, frame.isMirrored,
                        frame.yData, frame.uData, frame.vData, frame.yStride, frame.uStride, frame.vStride,
                        timestampMs, ownerEpoch, { epoch.get() == ownerEpoch && sampling === gestureSampling }) {
                        inFlight.set(false)
                    }
                    sample = owned
                    if (owned.isCurrent()) {
                        receiver(owned)
                        transferred = true
                        sample = null // The raw upload retains capture backpressure until it finishes.
                    }
                } catch (_: Exception) {
                    // Invalid samples never interrupt camera preview or XMAX generation.
                } finally {
                    if (sample != null) sample.close()
                    else if (!transferred) inFlight.set(false)
                }
            }
        })
    }

    private suspend fun observeErrors(
        owner: XmaxRealtimeManaging,
        ownerEpoch: Long,
    ): CompletableDeferred<Unit> {
        val previewReady = CompletableDeferred<Unit>()
        owner.setStateListener { state ->
            if (epoch.get() != ownerEpoch) return@setStateListener
            if (state.connectionState == RealtimeConnectionState.READY) previewReady.complete(Unit)
            if (state.reason is RealtimeReason.Failure) {
                previewReady.completeExceptionally(IllegalStateException("摄像头未就绪，请重试"))
                main.post {
                    if (epoch.get() == ownerEpoch) onError?.invoke("实时连接中断，请重试")
                }
            }
        }
        return previewReady
    }

    private suspend fun awaitCameraPreview(ready: CompletableDeferred<Unit>) {
        check(withTimeoutOrNull(10_000) { ready.await(); true } == true) { "摄像头未就绪，请重试" }
    }

    private suspend fun release() = withContext(NonCancellable) {
        epoch.incrementAndGet()
        val previous = manager
        manager = null
        localStream = null
        previewPosition = null
        previewDeviceId = null
        previewRequestedId = null
        previewRotationDegrees = 0
        previewCaptureSelection = NativeCameraCaptureSelection.Automatic
        captureInfo = null
        previewOnly = false
        firstFrameDelivered = false
        activeView.isInteractionEnabled = false
        activeView.remoteTrack = null
        activeView.localTrack = null
        activeView = view
        try {
            var failure: Throwable? = null
            val cleanup: List<suspend () -> Unit> = listOf(
                { previous?.setLocalVideoFrameListener(null); Unit },
                { previous?.setStateListener(null); Unit },
                { previous?.setRemoteVideoFrameListener(null); Unit },
                { previous?.close(); Unit },
            )
            for (operation in cleanup) {
                try { operation() }
                catch (error: Throwable) {
                    if (failure == null) failure = error else if (failure !== error) failure.addSuppressed(error)
                }
            }
            failure?.let { throw it }
        } catch (error: Throwable) {
            hasReleaseFailure = true
            throw error
        }
        check(!hasReleaseFailure) { "摄像头释放失败，请重新打开应用" }
    }
}
