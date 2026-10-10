package ai.openbuy.exhibition

import android.content.Context
import android.os.Handler
import android.os.Looper
import ai.xmax.sdk.CameraPosition
import ai.xmax.sdk.RealtimeConfiguration
import ai.xmax.sdk.RealtimeConnectionState
import ai.xmax.sdk.RealtimeContext
import ai.xmax.sdk.RealtimeMediaStream
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
import kotlinx.coroutines.CompletableDeferred
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
    private var previewOnly = false
    private var firstFrameDelivered = false

    var onFirstFrame: (() -> Unit)? = null
    var onError: ((String) -> Unit)? = null

    /** Local-only capture: no temporary key request or XMAX session is created. */
    suspend fun preview(position: CameraPosition = CameraPosition.BACK) =
        withContext(Dispatchers.Main.immediate) {
            mutex.withLock {
                if (previewOnly && previewPosition == position && localStream != null) return@withLock
                release()
                val ownerEpoch = epoch.get()
                // Client construction and createLocalCameraStream do not invoke an HTTP API.
                val next = client("local-preview-only", "cn")
                    .createRealtimeManager(RealtimeConfiguration(RealtimeModel.X2_0))
                manager = next
                previewOnly = true
                previewPosition = position
                try {
                    val ready = observeErrors(next, ownerEpoch)
                    localStream = camera(next, position)
                    view.videoContentMode = VideoContentMode.FIT
                    view.isInteractionEnabled = false
                    view.remoteTrack = null
                    view.localTrack = localStream?.videoTrack
                    awaitCameraPreview(ready)
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
    ): String = withContext(Dispatchers.Main.immediate) {
        require(model == "x2.0") { "当前仅支持 X2.0" }
        mutex.withLock {
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
                    camera(next, position)
                }
                localStream = source
                view.videoContentMode = VideoContentMode.FIT
                view.isInteractionEnabled = image != null
                view.localTrack = source.videoTrack
                if (image == null) awaitCameraPreview(ready)
                val remote = next.connect(source)
                val sessionId = next.currentState.sessionId?.takeIf { it.isNotBlank() }
                    ?: throw IllegalStateException("实时会话未就绪")
                view.remoteTrack = remote.videoTrack
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

    private suspend fun camera(
        owner: XmaxRealtimeManaging,
        position: CameraPosition,
    ): RealtimeMediaStream = owner.createLocalCameraStream(
        videoFormat = RealtimeVideoFormat(width = 704, height = 1280, fps = 24),
        position = position,
        useMicrophone = false,
    )

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

    private suspend fun release() {
        epoch.incrementAndGet()
        val previous = manager
        manager = null
        localStream = null
        previewPosition = null
        previewOnly = false
        firstFrameDelivered = false
        view.isInteractionEnabled = false
        view.remoteTrack = null
        view.localTrack = null
        previous?.setStateListener(null)
        previous?.setRemoteVideoFrameListener(null)
        previous?.close()
    }
}
