package ai.openbuy.exhibition

import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import ai.xmax.sdk.CameraPosition
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
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** Owns one native input and one official XMAX connection at a time. */
class NativeXmaxController(
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
    private var activeView = view
    private var previewOnly = false
    private var firstFrameDelivered = false
    internal var hasReleaseFailure = false
        private set

    var onFirstFrame: (() -> Unit)? = null
    var onError: ((String) -> Unit)? = null
    internal var onCameraSnapshot: ((NativeCameraSnapshot) -> Unit)? = null
    /** Receiver owns each sample and must close it, even when discarding it. */
    @Volatile var onLocalFrame: ((NativeCameraFrame) -> Unit)? = null

    /** Local-only capture: no temporary key request or XMAX session is created. */
    suspend fun preview(
        position: CameraPosition = CameraPosition.BACK,
        cameraDeviceId: String? = null,
        target: XmaxRealtimeVideoView = view,
    ): String =
        withContext(Dispatchers.Main.immediate) {
            mutex.withLock {
                check(!hasReleaseFailure) { "摄像头释放失败，请重新打开应用" }
                if (previewOnly && previewPosition == position && previewRequestedId == cameraDeviceId &&
                    activeView === target && localStream != null) return@withLock checkNotNull(previewDeviceId)
                release()
                activeView = target
                val ownerEpoch = epoch.get()
                // Client construction and createLocalCameraStream do not invoke an HTTP API.
                val next = client("local-preview-only", "cn")
                    .createRealtimeManager(RealtimeConfiguration(RealtimeModel.X2_0))
                manager = next
                previewOnly = true
                previewPosition = position
                previewRequestedId = cameraDeviceId
                try {
                    val ready = observeErrors(next, ownerEpoch)
                    localStream = camera(next, position, cameraDeviceId)
                    activeView.videoContentMode = VideoContentMode.FILL
                    activeView.isInteractionEnabled = false
                    activeView.remoteTrack = null
                    activeView.localTrack = localStream?.videoTrack
                    awaitCameraPreview(ready)
                    checkNotNull(previewDeviceId)
                } catch (error: Throwable) {
                    withContext(NonCancellable) { release() }
                    throw error
                }
            }
        }

    suspend fun uploadReference(
        token: String,
        region: String,
        bytes: ByteArray,
        mime: String,
    ): String {
        require(bytes.isNotEmpty() && bytes.size <= 64 * 1024 * 1024) { "参考图不可用" }
        val suffix = when (mime.lowercase()) {
            "image/jpeg" -> "jpg"
            "image/png" -> "png"
            "image/webp" -> "webp"
            else -> throw IllegalArgumentException("参考图格式不支持")
        }
        return client(token, region).createStorageManager().uploadImageWithSafetyCheck(
            data = bytes,
            fileName = "exhibition-${UUID.randomUUID()}.$suffix",
            contentType = mime.lowercase(),
        ).url
    }

    /** Connect and return the provider id; generation starts only after generate(). */
    suspend fun connect(
        token: String,
        region: String,
        model: String,
        position: CameraPosition = CameraPosition.BACK,
        image: ByteArray? = null,
        cameraDeviceId: String? = null,
    ): String = withContext(Dispatchers.Main.immediate) {
        require(model == "x2.0") { "当前仅支持 X2.0" }
        mutex.withLock {
            check(!hasReleaseFailure) { "摄像头释放失败，请重新打开应用" }
            release()
            val ownerEpoch = epoch.get()
            val next = client(token, region)
                .createRealtimeManager(RealtimeConfiguration(RealtimeModel.X2_0))
            manager = next
            try {
                val ready = observeErrors(next, ownerEpoch)
                val source = if (image != null) {
                    require(image.isNotEmpty() && image.size <= 64 * 1024 * 1024) { "输入图片不可用" }
                    next.createLocalImageStream(image)
                } else {
                    camera(next, position, cameraDeviceId)
                }
                localStream = source
                activeView.videoContentMode = VideoContentMode.FILL
                activeView.isInteractionEnabled = image != null
                activeView.localTrack = source.videoTrack
                if (image == null) awaitCameraPreview(ready)
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
                // Official 1.0.8 returns only after the current task's postprocessed
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
                .createRealtimeManager(RealtimeConfiguration(RealtimeModel.X2_0)).also { manager = it }
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
    ): RealtimeMediaStream {
        val detected = cameraSnapshot(owner)
        val selection = NativeCameraSelection(cameraDeviceId)
        val selected = selection.resolve(detected.devices)
            ?: throw IllegalStateException(selection.unavailableMessage(detected))
        previewDeviceId = selected.id
        observeLocalFrames(owner, epoch.get())
        return owner.createLocalCameraStream(
            videoFormat = RealtimeVideoFormat(width = 704, height = 1280, fps = 24),
            position = when (selected.facing) {
                NativeCameraFacing.FRONT -> CameraPosition.FRONT
                NativeCameraFacing.BACK, NativeCameraFacing.EXTERNAL -> CameraPosition.BACK
                NativeCameraFacing.UNKNOWN -> position
            },
            useMicrophone = false,
            cameraDeviceId = selected.id,
        )
    }

    private suspend fun observeLocalFrames(owner: XmaxRealtimeManaging, ownerEpoch: Long) {
        if (onLocalFrame == null) { owner.setLocalVideoFrameListener(null); return }
        val inFlight = AtomicBoolean()
        val lastSample = AtomicLong(Long.MIN_VALUE)
        owner.setLocalVideoFrameListener(object : RealtimeLocalVideoFrameListener {
            override fun shouldCaptureFrame(timestampMs: Long): Boolean {
                if (epoch.get() != ownerEpoch || onLocalFrame == null) return false
                val previous = lastSample.get()
                if (previous != Long.MIN_VALUE && timestampMs - previous < 100) return false
                if (!inFlight.compareAndSet(false, true)) return false
                lastSample.set(timestampMs)
                return true
            }
            override fun onFrameDropped() { inFlight.set(false) }
            override fun onFrame(frame: RealtimeVideoFrame, timestampMs: Long) {
                CoroutineScope(Dispatchers.Default).launch {
                    var sample: NativeCameraFrame? = null
                    var transferred = false
                    try {
                        if (epoch.get() != ownerEpoch || onLocalFrame == null) return@launch
                        val pixels = NativeCameraPixels.convert(frame.width, frame.height, frame.rotationDegrees,
                            frame.yData, frame.uData, frame.vData, frame.yStride, frame.uStride, frame.vStride, 640)
                        val bitmap = Bitmap.createBitmap(pixels.argb, pixels.width, pixels.height, Bitmap.Config.ARGB_8888)
                        val owned = NativeCameraFrame(bitmap, timestampMs, ownerEpoch, { epoch.get() == ownerEpoch }) { inFlight.set(false) }
                        sample = owned
                        val receiver = onLocalFrame
                        if (epoch.get() == ownerEpoch && receiver != null) {
                            receiver(owned)
                            transferred = true
                            sample = null // Ownership transferred; inference releases capture backpressure.
                        }
                    } catch (_: Exception) {
                        // Analysis never interrupts the RTC camera or the XMAX session.
                    } finally {
                        if (sample != null) sample.close()
                        else if (!transferred) inFlight.set(false)
                    }
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
