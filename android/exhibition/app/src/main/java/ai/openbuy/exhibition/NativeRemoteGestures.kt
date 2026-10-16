package ai.openbuy.exhibition

import android.graphics.Bitmap
import android.os.SystemClock
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.math.roundToInt

/** Samples only the existing RTC camera. There is one owned frame, no upload or action queue. */
internal class NativeRemoteGestures(
    private val transport: NativeGestureTransport,
    private val onState: (JSONObject) -> Unit,
    private val onError: (String) -> Unit,
    private val clock: () -> Long = SystemClock::elapsedRealtime,
    private val callbackDispatcher: CoroutineDispatcher = Dispatchers.Main.immediate,
    private val encode: (NativeCameraFrame, Int) -> ByteArray = ::encodeGestureJpeg,
) : AutoCloseable {
    private val scope = CoroutineScope(SupervisorJob() + callbackDispatcher)
    private val lock = Any()
    private var closed = false
    private var active = false
    private var blocked = true
    private var resetKey = ""
    private var needsReset = true
    private var ready = false
    private var epoch = 1L
    private var syncedEpoch = -1L
    private var sessionId: String? = null
    private var seq = 0L
    private var sourceGeneration = Long.MIN_VALUE
    private var lastTimestamp = Long.MIN_VALUE
    private var sampling = NativeGestureSampling.linux()
    private var frameOwned = false
    private var frameJob: Job? = null
    private var syncJob: Job? = null
    private var failures = 0
    private var retryAt = 0L

    /** Called on the Activity thread; configuration changes invalidate any earlier result immediately. */
    fun configure(enabled: Boolean, blocked: Boolean, resetKey: String, maxFps: Int = 15, inputLongEdge: Int = 720) {
        var invalidate = false
        synchronized(lock) {
            if (closed) return
            val nextSampling = NativeGestureSampling.linux(maxFps, inputLongEdge)
            val reset = this.resetKey != resetKey || sampling != nextSampling
            sampling = nextSampling
            if (active != enabled || this.blocked != blocked || reset) {
                active = enabled
                this.blocked = blocked
                this.resetKey = resetKey
                epoch++
                if (reset) { needsReset = true; ready = false }
                invalidate = true
            }
        }
        if (invalidate) frameJob?.cancel()
        synchronizeSession()
    }

    private data class Control(val sessionId: String, val epoch: Long, val blocked: Boolean, val reset: Boolean)

    /** A control may be superseded while HTTP is running. Epoch fencing makes either arrival order safe. */
    private fun synchronizeSession() {
        if (synchronized(lock) { closed || !active || (ready && !needsReset && syncedEpoch == epoch) } || syncJob?.isActive == true) return
        syncJob = scope.launch {
            while (isActive && !synchronized(lock) { closed || !active }) {
                val pause = synchronized(lock) { retryAt - clock() }
                if (pause > 0) delay(pause)
                try {
                    if (synchronized(lock) { sessionId == null }) {
                        val opened = transport.open()
                        val id = opened.optString("sessionId")
                        check(id.isNotEmpty() && id.length <= 128) { "Invalid gesture session" }
                        val accepted = synchronized(lock) {
                            if (closed || !active) false else {
                                sessionId = id
                                epoch = maxOf(epoch, opened.optLong("epoch", 0) + 1)
                                seq = 0
                                lastTimestamp = Long.MIN_VALUE
                                needsReset = true
                                ready = false
                                true
                            }
                        }
                        if (!accepted) { runCatching { transport.close(id) }; return@launch }
                    }
                    val control = synchronized(lock) {
                        Control(requireNotNull(sessionId), epoch, blocked, needsReset)
                    }
                    val response = transport.control(control.sessionId, control.epoch, control.blocked, control.reset)
                    val current = synchronized(lock) {
                        if (closed || !active || sessionId != control.sessionId || epoch != control.epoch) false
                        else { needsReset = false; ready = true; syncedEpoch = control.epoch; failures = 0; retryAt = 0; true }
                    }
                    if (!current) continue
                    // Control/open responses are feedback only, even if a malformed peer includes an event.
                    onState(JSONObject(response.toString()).put("event", JSONObject.NULL))
                    if (synchronized(lock) { epoch == control.epoch }) return@launch
                } catch (cancel: CancellationException) { throw cancel }
                catch (cause: Exception) {
                    if (cause is ExhibitionApiException && cause.code == "GESTURE_STALE") continue
                    loseSession()
                }
            }
        }
    }

    /** Takes ownership in every branch; called directly by the camera's bounded sampling callback. */
    fun submit(frame: NativeCameraFrame) {
        var changedGeneration = false
        val metadata = synchronized(lock) {
            val now = clock()
            if (closed || !active || !ready || sessionId == null || frameOwned || !frame.isCurrent() ||
                now - frame.timestampMs !in 0 until MAX_AGE_MS || frame.generation < sourceGeneration ||
                (lastTimestamp != Long.MIN_VALUE && frame.timestampMs - lastTimestamp < sampling.intervalMs)) null
            else {
                if (frame.generation != sourceGeneration) {
                    sourceGeneration = frame.generation
                    epoch++
                    changedGeneration = true
                }
                frameOwned = true
                lastTimestamp = frame.timestampMs
                NativeGestureUpload(requireNotNull(sessionId), epoch, seq++, frame.timestampMs, blocked) to sampling
            }
        }
        if (metadata == null) { frame.close(); return }
        val (upload, capturedSampling) = metadata
        val job = scope.launch(Dispatchers.IO, start = CoroutineStart.LAZY) {
            try {
                if (!isCurrent(upload, frame)) return@launch
                val jpeg = encode(frame, capturedSampling.inputLongEdge)
                if (!isCurrent(upload, frame)) return@launch
                val response = transport.frame(upload, jpeg)
                withContext(callbackDispatcher) {
                    if (!isCurrent(upload, frame) || response.optString("sessionId") != upload.sessionId ||
                        response.optLong("epoch", -1) != upload.epoch || response.optLong("seq", -1) != upload.seq ||
                        response.optLong("timestamp", -1) != upload.timestampMs)
                        return@withContext
                    onState(response)
                }
            } catch (cancel: CancellationException) { throw cancel }
            catch (cause: Exception) {
                withContext(callbackDispatcher) {
                    if (!isCurrent(upload, frame, checkAge = false)) return@withContext
                    if (cause is ExhibitionApiException && cause.code in DROP_FRAME_CODES) return@withContext
                    loseSession()
                    synchronizeSession()
                }
            }
        }
        job.invokeOnCompletion {
            frame.close()
            synchronized(lock) { frameOwned = false }
        }
        synchronized(lock) {
            frameJob = job
            if (closed || epoch != upload.epoch || !active) job.cancel()
        }
        job.start()
        if (changedGeneration) scope.launch { synchronizeSession() }
    }

    private fun isCurrent(metadata: NativeGestureUpload, frame: NativeCameraFrame, checkAge: Boolean = true) =
        synchronized(lock) {
            !closed && active && ready && metadata.sessionId == sessionId && metadata.epoch == epoch &&
                frame.generation == sourceGeneration && frame.isCurrent() &&
                (!checkAge || clock() - metadata.timestampMs in 0 until MAX_AGE_MS)
        }

    /** Failed sessions never retain pictures or gestures for reconnection. */
    private suspend fun loseSession() {
        val old = synchronized(lock) {
            if (closed) return
            val old = sessionId
            sessionId = null
            ready = false
            needsReset = true
            epoch++
            failures = (failures + 1).coerceAtMost(5)
            retryAt = clock() + minOf(8_000L, 500L shl (failures - 1))
            old
        }
        onError("手势连接中断，请重试。")
        if (old != null) scope.launch(Dispatchers.IO) { runCatching { transport.close(old) } }
    }

    override fun close() {
        val old = synchronized(lock) {
            if (closed) return
            closed = true
            active = false
            ready = false
            epoch++
            sessionId.also { sessionId = null }
        }
        scope.cancel()
        if (old != null) {
            // The Activity lifetime cannot cancel this bounded best-effort session release.
            val closing = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            closing.launch { try { transport.close(old) } catch (_: Exception) {} finally { closing.cancel() } }
        }
    }

    companion object {
        const val MAX_AGE_MS = 800L
        private val DROP_FRAME_CODES = setOf("GESTURE_BUSY", "GESTURE_STALE", "GESTURE_WARMING", "GESTURE_FRAME_EXPIRED",
            "GESTURE_UPLOAD_TIMEOUT", "GESTURE_UPLOAD_CANCELLED")
    }
}

/** Rotation already belongs to the RTC sampler; Linux applies the same landmark mirroring as local mode. */
internal fun encodeGestureJpeg(frame: NativeCameraFrame, inputLongEdge: Int = 720): ByteArray {
    val original = frame.bitmap
    val longEdge = NativeGestureSampling.linux(inputLongEdge = inputLongEdge).inputLongEdge
    val scale = minOf(1.0, longEdge.toDouble() / maxOf(original.width, original.height))
    val bitmap = if (scale < 1.0) Bitmap.createScaledBitmap(original,
        (original.width * scale).roundToInt().coerceAtLeast(1),
        (original.height * scale).roundToInt().coerceAtLeast(1), true) else original
    try {
        val output = ByteArrayOutputStream(32 * 1024)
        for (quality in 82 downTo 2 step 10) {
            output.reset()
            check(bitmap.compress(Bitmap.CompressFormat.JPEG, quality, output)) { "Gesture JPEG failed" }
            if (output.size() <= 256 * 1024) return output.toByteArray()
        }
        error("Gesture JPEG too large")
    } finally { if (bitmap !== original) bitmap.recycle() }
}
