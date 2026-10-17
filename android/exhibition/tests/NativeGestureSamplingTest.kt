package ai.openbuy.exhibition

import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicInteger
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
    val now = AtomicLong(10_000)
    val controls = CopyOnWriteArrayList<JSONObject>()
    val uploads = CopyOnWriteArrayList<NativeGestureUpload>()
    val states = CopyOnWriteArrayList<JSONObject>()
    val uploadedSizes = CopyOnWriteArrayList<Pair<Int, Int>>()
    val releases = CopyOnWriteArrayList<AtomicInteger>()
    val frames = CopyOnWriteArrayList<NativeGestureFrame>()
    val delayed = CompletableDeferred<Unit>()
    val callbacks = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    val transport = object : NativeGestureTransport {
        override suspend fun open() = JSONObject().put("sessionId", "fixture").put("epoch", 0).put("frameFormat", "i420-v1")
        override suspend fun control(sessionId: String, epoch: Long, blocked: Boolean, reset: Boolean) =
            JSONObject().put("epoch", epoch).put("reset", reset).also { controls.add(it) }
        override suspend fun frame(metadata: NativeGestureUpload, frame: NativeGestureFrame): JSONObject {
            uploads.add(metadata)
            uploadedSizes.add(frame.width to frame.height)
            if (uploads.size == 1) withContext(NonCancellable) { delayed.await() }
            return JSONObject().put("sessionId", metadata.sessionId).put("epoch", metadata.epoch)
                .put("seq", metadata.seq).put("timestamp", metadata.timestampMs).put("event", "open_palm")
        }
        override suspend fun close(sessionId: String) {}
    }
    val remote = NativeRemoteGestures(transport, { states.add(it) }, { error(it) }, now::get, callbacks)
    fun frame(step: Long = 100, generation: Long = 1): NativeGestureFrame {
        now.addAndGet(step)
        val count = AtomicInteger()
        return NativeGestureFrame(1920, 1080, 0, false, ByteBuffer.allocate(1920 * 1080),
            ByteBuffer.allocate(960 * 540), ByteBuffer.allocate(960 * 540), 1920, 960, 960,
            now.get(), generation, { true }) { count.incrementAndGet() }.also { frames.add(it); releases.add(count) }
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
        verify(!busy.isCurrent() && uploads.size == 1, "A cancelled encoder/upload still owns its frame until it exits")
        delayed.complete(Unit)
        await { !frames[0].isCurrent() }
        verify(states.none { it.has("seq") }, "Changing input settings discards the old response even with the same scope")
        verify(controls.last().getBoolean("reset") && controls.last().getLong("epoch") > oldEpoch,
            "Sampling changes invalidate inference and require a new release fence")
        remote.submit(frame(34))
        await { uploads.size == 2 && !frames.last().isCurrent() }
        verify(uploadedSizes == listOf(1920 to 1080, 1920 to 1080), "Changing computer input size never resizes the Android frame")
        now.addAndGet(100)
        val oldReceiver = checkNotNull(remote.frameReceiver())
        configure(5, 960)
        val crossedBoundary = frame(0)
        oldReceiver(crossedBoundary)
        verify(!crossedBoundary.isCurrent() && uploads.size == 2,
            "A copied frame from before settings changed cannot enter the new consumer epoch")
        val limited = frame(0)
        remote.submit(limited)
        verify(!limited.isCurrent() && uploads.size == 2, "Five FPS rejects a frame after only 100 ms")
        remote.submit(frame(100))
        await { uploads.size == 3 && !frames.last().isCurrent() }
        configure(30, 960)
        remote.submit(frame(34))
        await { uploads.size == 4 && !frames.last().isCurrent() }
        verify(uploads[3].timestampMs - uploads[2].timestampMs == 34L, "Linux supports 30 FPS instead of the old 10 FPS ceiling")
        now.addAndGet(100)
        val countBeforeGeneration = controls.size
        remote.submit(frame(0, 2))
        await { controls.size > countBeforeGeneration && remote.canAcceptFrame() }
        verify(uploads.size == 4 && !frames.last().isCurrent(), "A new camera generation resets once before sending")
        remote.submit(frame(34, 2))
        await { uploads.size == 5 && !frames.last().isCurrent() }
        remote.submit(frame(34, 2))
        await { uploads.size == 6 && !frames.last().isCurrent() }
        verify(controls.size == countBeforeGeneration + 1, "Later frames from the same camera do not reset repeatedly")
        verify(releases.all { it.get() == 1 }, "Every frame is released exactly once across configuration changes")
    } finally {
        delayed.complete(Unit)
        withContext(callbacks) { remote.close() }
        callbacks.close()
    }
    println("NativeGestureSampling: $assertions assertions passed; no camera or live service")
}
