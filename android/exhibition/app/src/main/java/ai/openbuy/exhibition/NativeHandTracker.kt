package ai.openbuy.exhibition

import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarker
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max
import kotlin.math.roundToInt

data class NativeHandPoint(val x: Float, val y: Float, val z: Float)
data class NativeTrackedHand(val handedness: String, val landmarks: List<NativeHandPoint>)
data class NativeHandResult(val hands: List<NativeTrackedHand>, val timestampMs: Long,
    val generation: Long, val inferenceMs: Long, val width: Int, val height: Int)

/** CPU inference owns one sample at a time; work submitted while busy is discarded. */
class NativeHandTracker(context: Context,
    private val onResult: (NativeHandResult) -> Unit,
    private val onError: (String) -> Unit,
) : AutoCloseable {
    private data class Settings(val detection: Float = .5f, val presence: Float = .5f,
        val tracking: Float = .5f, val maxFps: Int = 10, val longEdge: Int = 640)
    private val application = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { Thread(it, "openbuy-hand-inference").apply { isDaemon = true } }
    private val revision = AtomicLong()
    private val busy = AtomicBoolean()
    private val lock = Any()
    @Volatile private var closed = false
    @Volatile private var settings = Settings()
    @Volatile private var sourceGeneration = Long.MIN_VALUE
    private var lastAccepted = Long.MIN_VALUE
    // These fields are accessed only by the worker, including destruction.
    private var detector: HandLandmarker? = null
    private var detectorSettings: Settings? = null
    private var inferenceTimestamp = 0L
    private var reportedErrorRevision = Long.MIN_VALUE

    fun configure(minDetectionConfidence: Float = .5f, minPresenceConfidence: Float = .5f,
        minTrackingConfidence: Float = .5f, maxFps: Int = 10, inputLongEdge: Int = 640) {
        fun confidence(value: Float) = if (value.isFinite()) value.coerceIn(0f, 1f) else .5f
        val next = Settings(confidence(minDetectionConfidence), confidence(minPresenceConfidence),
            confidence(minTrackingConfidence), maxFps.coerceIn(1, 10), inputLongEdge.coerceIn(64, 640))
        synchronized(lock) {
            if (closed || settings == next) return
            settings = next
            revision.incrementAndGet()
            lastAccepted = Long.MIN_VALUE
        }
    }

    /** Invalidates frames without resetting the caller's gesture-release state. */
    fun invalidate() = synchronized(lock) {
        revision.incrementAndGet()
        lastAccepted = Long.MIN_VALUE
    }

    /** Takes ownership in every case; rejected samples are closed immediately. */
    fun submit(frame: NativeCameraFrame) {
        val captured: Pair<Long, Settings> = synchronized(lock) {
            if (closed || !frame.isCurrent() || frame.generation < sourceGeneration) { frame.close(); return }
            if (frame.generation != sourceGeneration) {
                sourceGeneration = frame.generation
                revision.incrementAndGet()
                lastAccepted = Long.MIN_VALUE
            }
            val current = settings
            if (lastAccepted != Long.MIN_VALUE && frame.timestampMs - lastAccepted < 1000L / current.maxFps) {
                frame.close(); return
            }
            if (!busy.compareAndSet(false, true)) { frame.close(); return }
            lastAccepted = frame.timestampMs
            revision.get() to current
        }
        try {
            worker.execute { infer(frame, captured.first, captured.second) }
        } catch (_: RejectedExecutionException) {
            frame.close()
            busy.set(false)
        }
    }

    private fun current(frame: NativeCameraFrame, capturedRevision: Long) = !closed &&
        revision.get() == capturedRevision && sourceGeneration == frame.generation && frame.isCurrent()

    private fun infer(frame: NativeCameraFrame, capturedRevision: Long, options: Settings) {
        var reduced: Bitmap? = null
        try {
            if (!current(frame, capturedRevision)) return
            if (reportedErrorRevision == capturedRevision) return
            val active = detectorFor(options)
            if (!current(frame, capturedRevision)) return
            val longest = max(frame.bitmap.width, frame.bitmap.height)
            val bitmap = if (longest > options.longEdge) {
                val scale = options.longEdge.toDouble() / longest
                Bitmap.createScaledBitmap(frame.bitmap, max(1, (frame.bitmap.width * scale).roundToInt()),
                    max(1, (frame.bitmap.height * scale).roundToInt()), true).also { reduced = it }
            } else frame.bitmap
            val started = android.os.SystemClock.elapsedRealtime()
            val width = bitmap.width
            val height = bitmap.height
            val image = BitmapImageBuilder(bitmap).build()
            val result = try {
                inferenceTimestamp = max(inferenceTimestamp + 1, frame.timestampMs)
                active.detectForVideo(image, inferenceTimestamp)
            } finally { image.close() }
            val hands = result.landmarks().mapIndexed { index, points ->
                NativeTrackedHand(result.handedness().getOrNull(index)?.firstOrNull()?.categoryName().orEmpty(),
                    points.map { NativeHandPoint(it.x(), it.y(), it.z()) })
            }
            val delivery = NativeHandResult(hands, frame.timestampMs, frame.generation,
                android.os.SystemClock.elapsedRealtime() - started, width, height)
            main.post { if (current(frame, capturedRevision)) onResult(delivery) }
        } catch (_: LinkageError) {
            reportFailure(frame, capturedRevision)
        } catch (_: Exception) {
            reportFailure(frame, capturedRevision)
        } finally {
            if (reduced != null && reduced !== frame.bitmap && !reduced.isRecycled) reduced.recycle()
            frame.close()
            busy.set(false)
        }
    }

    private fun reportFailure(frame: NativeCameraFrame, capturedRevision: Long) {
        // An unavailable native library or failed graph only disables gestures, never the camera/manual controls.
        runCatching { closeDetector() }
        if (reportedErrorRevision != capturedRevision) {
            reportedErrorRevision = capturedRevision
            main.post { if (current(frame, capturedRevision)) onError("手势识别暂不可用") }
        }
    }

    private fun detectorFor(options: Settings): HandLandmarker {
        val previous = detectorSettings
        if (detector != null && previous?.detection == options.detection && previous.presence == options.presence &&
            previous.tracking == options.tracking) return checkNotNull(detector)
        closeDetector()
        val base = BaseOptions.builder().setModelAssetPath("exhibition-gestures/hand_landmarker.task")
            .setDelegate(Delegate.CPU).build()
        return HandLandmarker.createFromOptions(application, HandLandmarker.HandLandmarkerOptions.builder()
            .setBaseOptions(base).setRunningMode(RunningMode.VIDEO).setNumHands(2)
            .setMinHandDetectionConfidence(options.detection).setMinHandPresenceConfidence(options.presence)
            .setMinTrackingConfidence(options.tracking).build()).also {
                detector = it
                detectorSettings = options
                inferenceTimestamp = 0
            }
    }

    private fun closeDetector() {
        val previous = detector
        detector = null
        detectorSettings = null
        previous?.close()
    }

    override fun close() {
        synchronized(lock) {
            if (closed) return
            closed = true
            revision.incrementAndGet()
        }
        // Queued inference checks closed, closes its sample, then model teardown runs on the same thread.
        worker.execute { closeDetector() }
        worker.shutdown()
    }
}
