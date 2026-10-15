package ai.openbuy.exhibition

import android.graphics.Bitmap
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.*
import org.json.JSONObject
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/** Actual uploader and HTTP transport; only Bitmap pixels and the disposable Linux peer are substituted. */
fun main() = runBlocking {
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    val workers = Executors.newCachedThreadPool()
    server.executor = workers
    val callbacks = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    val now = AtomicLong(10_000)
    val opens = AtomicInteger()
    val uploads = CopyOnWriteArrayList<NativeGestureUpload>()
    val controls = CopyOnWriteArrayList<JSONObject>()
    val closes = AtomicInteger()
    val failures = CopyOnWriteArrayList<Throwable>()
    val states = CopyOnWriteArrayList<JSONObject>()
    val errors = CopyOnWriteArrayList<String>()
    val frameAction = AtomicReference<(HttpExchange, JSONObject) -> Unit>({ exchange, response -> exchange.replyGesture(response) })
    var assertions = 0
    fun verify(condition: Boolean, label: String) { check(condition) { label }; assertions++ }
    suspend fun await(label: String, predicate: () -> Boolean) {
        withTimeout(5_000) { while (!predicate()) { failures.firstOrNull()?.let { throw it }; delay(10) } }
    }
    val prefix = "/v1.1/api/exhibition/mirrors/default/gestures/"
    server.createContext("/") { exchange ->
        try {
            check(exchange.requestMethod == "POST")
            check(exchange.requestHeaders.getFirst("Origin") == "http://127.0.0.1:${server.address.port}")
            check(exchange.requestHeaders.getFirst("Cache-Control") == "no-store")
            val route = exchange.requestURI.path.removePrefix(prefix)
            if (route == "frame") {
                check(exchange.requestHeaders.getFirst("Content-Type") == "image/jpeg")
                check(exchange.requestHeaders.getFirst("X-OpenBuy-Terminal-Id") == "terminal-fixture")
                check(exchange.requestHeaders.getFirst("X-OpenBuy-Terminal-Token") == "fixture-secret")
                check(exchange.requestBody.readBytes().isNotEmpty())
                fun header(name: String) = exchange.requestHeaders.getFirst("X-OpenBuy-Gesture-$name")
                val metadata = NativeGestureUpload(header("Session"), header("Epoch").toLong(), header("Seq").toLong(),
                    header("Time").toLong(), header("Blocked").toBooleanStrict())
                uploads.add(metadata)
                val snapshot = JSONObject().put("sessionId", metadata.sessionId).put("epoch", metadata.epoch)
                    .put("seq", metadata.seq).put("timestamp", metadata.timestampMs).put("blocked", metadata.blocked)
                    .put("operatorStatus", "locked").put("event", "open_palm").put("inferenceMs", 30)
                frameAction.get()(exchange, snapshot)
            } else {
                val body = JSONObject(exchange.requestBody.bufferedReader().use { it.readText() })
                check(body.getString("terminalId") == "terminal-fixture" && body.getString("terminalToken") == "fixture-secret")
                when (route) {
                    "open" -> exchange.replyGesture(JSONObject().put("sessionId", "session-${opens.incrementAndGet()}").put("epoch", 0))
                    "control" -> {
                        controls.add(body)
                        exchange.replyGesture(JSONObject(body.toString()).put("event", "open_palm").put("needsRelease", true))
                    }
                    "close" -> { closes.incrementAndGet(); exchange.replyGesture(JSONObject().put("ok", true)) }
                    else -> error("Unexpected request ${exchange.requestURI}")
                }
            }
        } catch (error: Throwable) { if (error !is java.io.IOException) failures.add(error) }
        finally { exchange.close() }
    }
    server.start()
    val api = ExhibitionApi("http://127.0.0.1:${server.address.port}/v1.1/exhibition/screen", "terminal-fixture", "fixture-secret", "test")
    val remote = NativeRemoteGestures(api.gestures("default"), { states.add(JSONObject(it.toString())) }, errors::add,
        now::get, callbacks)
    val frames = CopyOnWriteArrayList<NativeCameraFrame>()
    val recycled = CopyOnWriteArrayList<AtomicInteger>()
    fun frame(generation: Long = 1, current: () -> Boolean = { true }): NativeCameraFrame {
        now.addAndGet(110)
        val releases = AtomicInteger()
        return NativeCameraFrame(Bitmap(640, 360), now.get(), generation, current) { releases.incrementAndGet() }
            .also { frames.add(it); recycled.add(releases) }
    }
    suspend fun configure(blocked: Boolean, key: String = "scope") = withContext(callbacks) { remote.configure(true, blocked, key) }
    fun frameStates() = states.count { it.has("seq") }
    try {
        configure(false)
        await("open and control") { states.isNotEmpty() }
        verify(opens.get() == 1 && controls.last().getBoolean("reset"), "A new session requires a release fence")
        verify(states.all { it.isNull("event") }, "Control snapshots cannot dispatch commands")
        val firstResponse = CountDownLatch(1)
        frameAction.set { exchange, response -> firstResponse.await(3, TimeUnit.SECONDS); exchange.replyGesture(response) }
        remote.submit(frame())
        await("first upload") { uploads.size == 1 }
        val dropped = frame()
        remote.submit(dropped)
        verify(dropped.bitmap.recycleCount.get() == 1, "Busy uploader drops and releases the next frame")
        verify(uploads.size == 1, "No pending image is uploaded behind an in-flight frame")
        configure(true)
        await("cancelled frame release") { recycled[0].get() == 1 }
        firstResponse.countDown()
        delay(80)
        verify(frameStates() == 0, "A response from before busy cannot dispatch")
        await("busy control") { controls.last().getBoolean("blocked") }
        frameAction.set { exchange, response -> exchange.replyGesture(response) }
        remote.submit(frame())
        await("busy release sampling") { frameStates() == 1 }
        verify(states.last { it.has("seq") }.getBoolean("blocked"), "Busy frames still reach inference for release tracking")
        verify(uploads.last().seq > uploads.first().seq, "Sequence stays monotonic across busy epochs")

        configure(false)
        await("unblock control") { !controls.last().getBoolean("blocked") }
        val delayed = CountDownLatch(1)
        frameAction.set { exchange, response -> delayed.await(3, TimeUnit.SECONDS); exchange.replyGesture(response) }
        val before = frameStates()
        remote.submit(frame())
        await("delayed upload") { uploads.size == 3 }
        now.addAndGet(801)
        delayed.countDown()
        await("stale frame closed") { recycled.last().get() == 1 }
        verify(frameStates() == before, "An 800 ms old frame never reaches the Activity")
        val outdated = frame(0)
        remote.submit(outdated)
        verify(outdated.bitmap.recycleCount.get() == 1 && uploads.size == 3, "Earlier camera generations are discarded")

        frameAction.set { exchange, _ -> exchange.replyGesture(JSONObject().put("code", "GESTURE_BUSY"), 409) }
        remote.submit(frame())
        await("busy frame done") { recycled.last().get() == 1 }
        verify(opens.get() == 1 && errors.isEmpty(), "Worker busy drops a frame without reopening or erroring")

        frameAction.set { exchange, _ -> exchange.replyGesture(JSONObject().put("code", "GESTURE_SESSION_INVALID"), 409) }
        remote.submit(frame())
        await("invalid session") { errors.size == 1 }
        verify(opens.get() == 1, "Reconnect starts after backoff, never retrying the image")
        now.addAndGet(1_000)
        frameAction.set { exchange, response -> exchange.replyGesture(response) }
        await("new session") { opens.get() == 2 && controls.last().optString("sessionId") == "session-2" }
        await("new session control") { states.last().optString("sessionId") == "session-2" }
        verify(controls.last().getBoolean("reset"), "Reconnection requires release again")
        remote.submit(frame())
        await("new session frame") { uploads.last().sessionId == "session-2" }
        await("new frame done") { recycled.last().get() == 1 }
        verify(uploads.last().seq == 0L, "Only a new session restarts sequence numbering")

        val closingFrame = CountDownLatch(1)
        frameAction.set { exchange, response -> closingFrame.await(3, TimeUnit.SECONDS); exchange.replyGesture(response) }
        val finalBefore = frameStates()
        remote.submit(frame())
        await("last frame in flight") { uploads.size == 7 }
        withContext(callbacks) { remote.close() }
        closingFrame.countDown()
        await("all frame ownership returned") { recycled.all { it.get() == 1 } }
        delay(80)
        verify(frameStates() == finalBefore, "Closing cannot deliver a late gesture")
        verify(frames.all { it.bitmap.recycleCount.get() == 1 }, "Every accepted and rejected bitmap is recycled exactly once")
        await("session close") { closes.get() >= 2 }
        verify(failures.isEmpty(), "All real HTTP headers, credentials, paths and bodies match the contract")
        val countBeforeTimeout = uploads.size
        frameAction.set { exchange, response -> Thread.sleep(2_000); exchange.replyGesture(response) }
        val started = System.nanoTime()
        try {
            api.gestures("default").frame(NativeGestureUpload("session-timeout", 1, 0, now.get(), true), byteArrayOf(1))
            error("Expected bounded frame timeout")
        } catch (_: ExhibitionApiException) { /* Actual OkHttp total call timeout, no retries. */ }
        val elapsed = (System.nanoTime() - started) / 1_000_000
        verify(elapsed in 800..1_800, "Frame networking ends near the 1200 ms hard deadline: $elapsed ms")
        verify(uploads.size == countBeforeTimeout + 1, "Timed-out POST is not automatically retransmitted")
        println("NativeRemoteGestures: $assertions assertions passed; disposable HTTP peer only.")
    } finally {
        withContext(callbacks) { remote.close() }
        server.stop(0)
        workers.shutdownNow()
        callbacks.close()
    }
}

private fun HttpExchange.replyGesture(value: JSONObject, status: Int = 200) {
    val bytes = value.toString().toByteArray()
    responseHeaders.set("Content-Type", "application/json; charset=utf-8")
    sendResponseHeaders(status, bytes.size.toLong())
    responseBody.use { it.write(bytes) }
}
