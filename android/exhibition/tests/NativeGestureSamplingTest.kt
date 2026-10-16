package ai.openbuy.exhibition

import android.graphics.Bitmap
import kotlinx.coroutines.*
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

fun main() = runBlocking {
    var assertions = 0
    fun verify(value: Boolean, message: String) { check(value) { message }; assertions++ }
    suspend fun await(predicate: () -> Boolean) { withTimeout(5_000) { while (!predicate()) delay(5) } }
    verify(NativeGestureSampling.LOCAL.maxFps == 10 && NativeGestureSampling.LOCAL.inputLongEdge == 640,
        "Local mode retains its original sampling budget")
    verify(NativeGestureSampling.linux().maxFps == 15 && NativeGestureSampling.linux().inputLongEdge == 720,
        "Linux defaults match the web settings")
    verify(NativeGestureSampling.linux(100, 640) == NativeGestureSampling.linux(30, 720), "Linux settings are bounded")
    verify(NativeGestureSampling.linux(1, 480).intervalMs == 200L && NativeGestureSampling.linux(30).intervalMs == 34L,
        "Sampling intervals never exceed the configured frame rate")
    for (edge in listOf(480, 720, 960)) {
        val original = Bitmap(1920, 1080)
        val frame = NativeCameraFrame(original, 1, 1, { true }) {}
        encodeGestureJpeg(frame, edge)
        val scaled = original.scaled.single()
        verify(scaled.width == edge && scaled.height == edge * 9 / 16 && scaled.qualities == listOf(82),
            "JPEG retains the configured $edge input and starts at quality 82")
        verify(scaled.recycleCount.get() == 1 && !original.isRecycled, "Encoding only releases its own reduced bitmap")
        frame.close()
    }
    val small = Bitmap(320, 180)
    val smallFrame = NativeCameraFrame(small, 1, 1, { true }) {}
    encodeGestureJpeg(smallFrame, 960)
    verify(small.scaled.isEmpty() && small.qualities == listOf(82), "Small camera inputs are never enlarged")
    smallFrame.close()
    val noisy = Bitmap(960, 540) { quality -> if (quality >= 62) 256 * 1024 + 1 else 256 * 1024 }
    val noisyFrame = NativeCameraFrame(noisy, 1, 1, { true }) {}
    val jpeg = encodeGestureJpeg(noisyFrame, 960)
    verify(jpeg.size == 256 * 1024 && noisy.qualities == listOf(82, 72, 62, 52) && noisy.scaled.isEmpty(),
        "Oversized JPEG lowers quality while preserving resolution and the 256 KiB bound")
    noisyFrame.close()
    val impossible = Bitmap(1920, 1080) { 256 * 1024 + 1 }
    val impossibleFrame = NativeCameraFrame(impossible, 1, 1, { true }) {}
    verify(runCatching { encodeGestureJpeg(impossibleFrame, 960) }.isFailure, "Unbounded JPEG never reaches transport")
    verify(impossible.scaled.single().recycleCount.get() == 1 && !impossible.isRecycled,
        "Failed encoding releases only its own bitmap")
    impossibleFrame.close()

    val now = AtomicLong(10_000)
    val controls = CopyOnWriteArrayList<JSONObject>()
    val uploads = CopyOnWriteArrayList<NativeGestureUpload>()
    val states = CopyOnWriteArrayList<JSONObject>()
    val encodedEdges = CopyOnWriteArrayList<Int>()
    val frames = CopyOnWriteArrayList<NativeCameraFrame>()
    val delayed = CompletableDeferred<Unit>()
    val callbacks = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    val transport = object : NativeGestureTransport {
        override suspend fun open() = JSONObject().put("sessionId", "fixture").put("epoch", 0)
        override suspend fun control(sessionId: String, epoch: Long, blocked: Boolean, reset: Boolean) =
            JSONObject().put("epoch", epoch).put("reset", reset).also { controls.add(it) }
        override suspend fun frame(metadata: NativeGestureUpload, jpeg: ByteArray): JSONObject {
            uploads.add(metadata)
            if (uploads.size == 1) withContext(NonCancellable) { delayed.await() }
            return JSONObject().put("sessionId", metadata.sessionId).put("epoch", metadata.epoch)
                .put("seq", metadata.seq).put("timestamp", metadata.timestampMs).put("event", "open_palm")
        }
        override suspend fun close(sessionId: String) {}
    }
    val remote = NativeRemoteGestures(transport, { states.add(it) }, { error(it) }, now::get, callbacks,
        encode = { frame, edge -> encodedEdges.add(edge); encodeGestureJpeg(frame, edge) })
    fun frame(step: Long = 100): NativeCameraFrame {
        now.addAndGet(step)
        return NativeCameraFrame(Bitmap(960, 540), now.get(), 1, { true }) {}.also { frames.add(it) }
    }
    suspend fun configure(fps: Int, edge: Int) {
        val count = controls.size
        withContext(callbacks) { remote.configure(true, false, "unchanged-scope", fps, edge) }
        await { controls.size > count && states.any { it.optLong("epoch") == controls.last().optLong("epoch") } }
    }
    try {
        configure(15, 720)
        remote.submit(frame())
        await { uploads.size == 1 }
        val oldEpoch = uploads[0].epoch
        configure(30, 960)
        val busy = frame()
        remote.submit(busy)
        verify(busy.bitmap.isRecycled && uploads.size == 1, "A cancelled encoder/upload still owns its frame until it exits")
        delayed.complete(Unit)
        await { frames[0].bitmap.isRecycled }
        verify(states.none { it.has("seq") }, "Changing input settings discards the old response even with the same scope")
        verify(controls.last().getBoolean("reset") && controls.last().getLong("epoch") > oldEpoch,
            "Sampling changes invalidate inference and require a new release fence")
        remote.submit(frame(34))
        await { uploads.size == 2 && frames.last().bitmap.isRecycled }
        verify(encodedEdges == listOf(720, 960), "New frames use the updated dimension, without queued old images")
        configure(5, 960)
        val limited = frame(100)
        remote.submit(limited)
        verify(limited.bitmap.isRecycled && uploads.size == 2, "Five FPS rejects a frame after only 100 ms")
        remote.submit(frame(100))
        await { uploads.size == 3 && frames.last().bitmap.isRecycled }
        configure(30, 960)
        remote.submit(frame(34))
        await { uploads.size == 4 && frames.last().bitmap.isRecycled }
        verify(uploads[3].timestampMs - uploads[2].timestampMs == 34L, "Linux supports 30 FPS instead of the old 10 FPS ceiling")
        verify(frames.all { it.bitmap.recycleCount.get() == 1 }, "Every frame is released exactly once across configuration changes")
    } finally {
        delayed.complete(Unit)
        withContext(callbacks) { remote.close() }
        callbacks.close()
    }
    println("NativeGestureSampling: $assertions assertions passed; no camera or live service")
}
