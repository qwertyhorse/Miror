package ai.openbuy.exhibition

import ai.xmax.sdk.CameraPosition
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject

/**
 * Run scripts/test-native.sh. This compiles the real API and coordinator against only
 * tests/stubs, installs their META-INF/services Main dispatcher, and talks exclusively
 * to an ephemeral loopback HttpServer. No provider SDK, network, camera, or token issuer
 * is loaded. All token strings below are nonfunctional fixture values.
 */
fun main() = runBlocking {
    var assertions = 0
    fun verify(value: Boolean, message: String) { check(value) { message }; assertions++ }
    fun ordered(events: List<String>, vararg wanted: String) {
        var previous = -1
        for (event in wanted) {
            val index = events.indexOf(event)
            verify(index > previous, "Missing or out-of-order fixture event: $event in $events")
            previous = index
        }
    }
    try {
        // The three supported input shapes exercise the same production coordinator.
        for (mode in listOf("clothx", "free", "mox")) {
            RoundFixture(mode, noReference = mode == "free", holdFirstFrame = mode == "clothx").use { fixture ->
                val controller = NativeXmaxController(fixture.events)
                val running = startRound(fixture, controller)
                try {
                    if (fixture.holdFirstFrame) {
                        fixture.firstFrameEntered.awaitFixture()
                        verify(!running.firstFrame.isCompleted, "UI advanced before backend first-frame acknowledgement")
                        fixture.releaseFirstFrame.countDown()
                    }
                    withTimeout(5_000) { running.firstFrame.await() }
                    verify(running.failure.isCompleted.not(), "Normal generation failed")
                    verify(running.round.key == "default:2:3:commute:$mode", "Immutable round identity")
                    if (mode == "free") {
                        ordered(fixture.events, "create", "connect", "link", "generate", "remote-frame", "report-first", "ui-first")
                        verify(fixture.events.none { it in listOf("image", "upload", "bind") }, "Free none sent its cover as a reference")
                        verify(controller.generatedPrompt == "自定义提示词" && controller.generatedReference == null, "Free prompt-only payload")
                    } else {
                        ordered(fixture.events, "image", "create", "upload", "bind", "connect", "link", "generate", "remote-frame", "report-first", "ui-first")
                        verify(controller.uploadedBytes!!.contentEquals(fixture.imageBytes), "Downloaded reference was not uploaded")
                        verify(controller.uploadedMime == "image/png", "Image MIME did not match its bytes")
                        verify(controller.generatedReference == RoundFixture.REFERENCE_URL, "Generation used an unbound reference")
                    }
                    verify((controller.connectedImage != null) == (mode == "mox"), "MoX/photo versus camera source")
                    if (mode == "mox") verify(controller.connectedImage!!.contentEquals(fixture.imageBytes), "MoX did not use the selected image")
                    verify(controller.connectedPosition == CameraPosition.FRONT, "Camera selection was lost")
                    verify(running.callbackThreads.all { it == "fixture-main" }, "UI callback left Main")
                } finally {
                    fixture.releaseFirstFrame.countDown()
                    running.job.cancelAndJoin()
                }
                verify(fixture.allocations.get() == 1, "Coordinator retried credential allocation")
                verify(fixture.stoppedIds.toList() == listOf(RoundFixture.SESSION_ID), "Normal cancellation did not stop the reservation")
                verify(fixture.events.contains("disconnect"), "Normal cancellation did not release native resources")
                verify(fixture.errorReports.get() == 0 && running.errors.isEmpty(), "Cancellation was reported as an experience error")
                fixture.checkHandler()
            }
        }

        // A server-side allocation can exist even though the create reply never reaches run().
        for (otherOwner in listOf(false, true)) {
            RoundFixture("clothx", holdCreate = true, recoveryOtherOwner = otherOwner).use { fixture ->
                val running = startRound(fixture, NativeXmaxController(fixture.events))
                try {
                    fixture.createEntered.awaitFixture()
                    running.job.cancel()
                    fixture.releaseCreate.countDown()
                    withTimeout(5_000) { running.job.join() }
                    verify(fixture.events.contains("state"), "Lost create reply did not re-read backend ownership")
                    verify(fixture.allocations.get() == 1, "Cancelled allocation was retried")
                    verify(fixture.stoppedIds.toList() == if (otherOwner) emptyList<String>() else listOf(RoundFixture.SESSION_ID),
                        "Recovery failed to respect terminal ownership")
                    verify(fixture.events.none { it in listOf("upload", "connect", "generate") }, "Cancelled allocation reached the supplier")
                    verify(fixture.errorReports.get() == 0 && running.errors.isEmpty(), "Lost-reply cancellation reported an error")
                    verify(fixture.events.contains("disconnect"), "Lost-reply cancellation skipped native cleanup")
                    fixture.checkHandler()
                } finally {
                    fixture.releaseCreate.countDown()
                    running.job.cancelAndJoin()
                }
            }
        }

        RoundFixture("clothx").use { fixture ->
            val controller = NativeXmaxController(fixture.events).apply { failConnect = true }
            val running = startRound(fixture, controller)
            try {
                withTimeout(5_000) { running.failure.await() }
                running.job.join()
                ordered(fixture.events, "bind", "connect", "report-error")
                verify(fixture.allocations.get() == 1, "Connection failure issued a second credential")
                verify(fixture.events.none { it in listOf("link", "generate", "ui-first") }, "Connection failure continued generating")
                verify(fixture.stoppedIds.toList() == listOf(RoundFixture.SESSION_ID) && fixture.events.contains("disconnect"), "Connection failure did not settle both resources")
                verify(fixture.errorReports.get() == 1 && running.errors.size == 1, "Connection failure was not reported once")
                verify(running.errors.none { it.contains("tk-fixture") || it.contains("https://") }, "Error callback exposed fixture credentials")
                verify(running.callbackThreads.all { it == "fixture-main" }, "Failure callback left Main")
                fixture.checkHandler()
            } finally { running.job.cancelAndJoin() }
        }

        RoundFixture("free", noReference = true, stopConfirmed = false).use { fixture ->
            val running = startRound(fixture, NativeXmaxController(fixture.events))
            try {
                withTimeout(5_000) { running.firstFrame.await() }
                running.job.cancelAndJoin()
                verify(running.errors.any { it == "云端停止尚未确认，请重试停止。" }, "Unconfirmed backend stop was swallowed")
                verify(fixture.stoppedIds.toList() == listOf(RoundFixture.SESSION_ID), "Unconfirmed stop skipped the backend attempt")
                verify(fixture.events.contains("disconnect"), "Unconfirmed stop prevented local cleanup")
                verify(fixture.errorReports.get() == 0, "Cancellation produced a generation error report")
                verify(running.callbackThreads.all { it == "fixture-main" }, "Cleanup error callback left Main")
                fixture.checkHandler()
            } finally { running.job.cancelAndJoin() }
        }
        println("Native round flow passed: 7 isolated flows, $assertions assertions; no supplier SDK or live service calls.")
    } finally { FixtureMainDispatcher.close() }
}

private data class RunningRound(
    val round: NativeGenerationRound,
    val job: Job,
    val firstFrame: CompletableDeferred<Unit>,
    val failure: CompletableDeferred<Throwable>,
    val errors: MutableList<String>,
    val callbackThreads: MutableList<String>,
)

private fun CoroutineScope.startRound(fixture: RoundFixture, controller: NativeXmaxController): RunningRound {
    val firstFrame = CompletableDeferred<Unit>()
    val failure = CompletableDeferred<Throwable>()
    val errors = CopyOnWriteArrayList<String>()
    val threads = CopyOnWriteArrayList<String>()
    val round = NativeGenerationRound(
        fixture.api, "default", "device-fixture", fixture.snapshot(), fixture.look,
        controller, onStatus = { threads.add(Thread.currentThread().name) },
        onError = { threads.add(Thread.currentThread().name); errors.add(it) },
        onFirstFrame = { threads.add(Thread.currentThread().name); fixture.events.add("ui-first"); firstFrame.complete(Unit) },
        cameraPosition = CameraPosition.FRONT,
    )
    val job = launch {
        try { round.run() }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Throwable) { failure.complete(error) }
    }
    return RunningRound(round, job, firstFrame, failure, errors, threads)
}

private class RoundFixture(
    mode: String,
    noReference: Boolean = false,
    val holdFirstFrame: Boolean = false,
    private val holdCreate: Boolean = false,
    private val recoveryOtherOwner: Boolean = false,
    private val stopConfirmed: Boolean = true,
) : AutoCloseable {
    val events = CopyOnWriteArrayList<String>()
    val allocations = AtomicInteger()
    val errorReports = AtomicInteger()
    val stoppedIds = CopyOnWriteArrayList<String>()
    val createEntered = CountDownLatch(1)
    val releaseCreate = CountDownLatch(1)
    val firstFrameEntered = CountDownLatch(1)
    val releaseFirstFrame = CountDownLatch(1)
    val imageBytes = byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10)
    val look = JSONObject().put("id", "commute").put("mode", mode)
        .put("referenceKind", if (noReference) "none" else "image")
        .put("image", "/assets/exhibition/commute-cutout.png").put("prompt", "  自定义提示词  ")
    private val state = JSONObject().put("providerMode", "xmax").put("phase", "generating")
        .put("experienceMode", mode).put("selectedLookId", "commute").put("sessionNumber", 2)
        .put("generationNumber", 3).put("revision", 4).put("live", JSONObject.NULL)
    private val record = JSONObject().put("id", SESSION_ID).put("status", "active")
        .put("sourceKind", if (mode == "mox") "photo" else "camera")
        .put("referenceAsset", if (noReference) "" else look.getString("image"))
        .put("referenceVersion", 0).put("refImageUrl", "").put("providerRegion", "cn")
        .put("expiresAt", Instant.now().plusSeconds(120).toString())
        .put("exhibition", JSONObject().put("mirrorId", "default").put("deviceId", "device-fixture")
            .put("lookId", "commute").put("mode", mode).put("prompt", NativeRoundMetadata.prompt(look))
            .put("sessionNumber", 2).put("generationNumber", 3))
    private val failure = AtomicReference<Throwable>()
    private val lock = Any()
    private val executor = Executors.newCachedThreadPool()
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply { this.executor = this@RoundFixture.executor }
    init {
        server.createContext("/") { exchange ->
            try { handle(exchange) }
            catch (error: Throwable) {
                failure.compareAndSet(null, error)
                try { exchange.json(JSONObject().put("error", "fixture handler failed"), 500) } catch (_: Exception) { }
            } finally { exchange.close() }
        }
        server.start()
    }
    val api = ExhibitionApi("http://127.0.0.1:${server.address.port}/v1.1/exhibition/screen?mirror=default",
        "terminal-fixture", "fixture-terminal-credential", "隔离测试智能镜")
    fun snapshot() = synchronized(lock) { JSONObject(state.toString()) }
    fun checkHandler() { failure.get()?.let { throw AssertionError("Local fixture handler failed", it) } }

    private fun handle(exchange: HttpExchange) {
        val path = exchange.requestURI.path
        when {
            path == "/v1.1/assets/exhibition/commute-cutout.png" -> {
                events.add("image"); exchange.bytes(imageBytes, "image/png")
            }
            path == "$MIRROR/live/session" -> {
                check(exchange.requestMethod == "POST")
                val body = exchange.body()
                check(body.getString("deviceId") == "device-fixture" && body.getString("lookId") == "commute")
                check(body.getLong("generationNumber") == 3L && body.getLong("expectedRevision") == 4L)
                allocations.incrementAndGet(); events.add("create")
                synchronized(lock) {
                    state.put("live", JSONObject().put("deviceId", if (recoveryOtherOwner) "another-device" else "device-fixture")
                        .put("lookId", "commute").put("generationNumber", 3)
                        .put("sessionId", if (recoveryOtherOwner) OTHER_SESSION_ID else SESSION_ID))
                }
                createEntered.countDown()
                if (holdCreate) check(releaseCreate.await(5, TimeUnit.SECONDS))
                val created = synchronized(lock) { JSONObject(record.toString()).put("token", "tk-fixture").put("model", "x2.0") }
                // A cancelled request intentionally discards this reply after allocation.
                try { exchange.json(created, 201) } catch (error: Exception) { if (!holdCreate) throw error }
            }
            path == "$MIRROR/live/heartbeat" -> { events.add("heartbeat"); exchange.json(snapshot()) }
            path == "$MIRROR/live/session/$SESSION_ID/reference" -> {
                val body = exchange.body()
                check(body.getString("deviceId") == "device-fixture" && body.getString("lookId") == "commute")
                check(body.getString("refImageUrl") == REFERENCE_URL)
                val bound = synchronized(lock) {
                    record.put("refImageUrl", REFERENCE_URL).put("referenceVersion", 1)
                    JSONObject(record.toString())
                }
                events.add("bind"); exchange.json(bound)
            }
            path == "$MIRROR/sessions/$SESSION_ID/link" -> {
                check(exchange.body().getString("providerSessionId") == "ums-fixture")
                val linked = synchronized(lock) { record.put("providerSessionId", "ums-fixture"); JSONObject(record.toString()) }
                events.add("link"); exchange.json(linked)
            }
            path == "$MIRROR/sessions/$SESSION_ID/first-frame" -> {
                val elapsed = exchange.body().getLong("firstFrameMs")
                check(elapsed in 0L..120_000L)
                events.add("report-first"); firstFrameEntered.countDown()
                if (holdFirstFrame) check(releaseFirstFrame.await(5, TimeUnit.SECONDS))
                val receipt = synchronized(lock) { record.put("firstFrameMs", elapsed); JSONObject(record.toString()) }
                exchange.json(receipt)
            }
            path == "$MIRROR/live/error" -> {
                val message = exchange.body().getString("message")
                check(!message.contains("tk-fixture") && !message.contains("https://"))
                errorReports.incrementAndGet(); events.add("report-error"); exchange.json(snapshot())
            }
            path.startsWith("$MIRROR/sessions/") && path.endsWith("/stop") -> {
                val id = path.removePrefix("$MIRROR/sessions/").removeSuffix("/stop")
                stoppedIds.add(id); events.add("stop")
                exchange.json(JSONObject().put("id", id).put("status", if (stopConfirmed) "stopped" else "stopping"))
            }
            path == MIRROR -> { events.add("state"); exchange.json(snapshot()) }
            else -> error("Unexpected local fixture endpoint: $path")
        }
    }
    override fun close() {
        releaseCreate.countDown(); releaseFirstFrame.countDown()
        server.stop(0); executor.shutdownNow()
    }
    companion object {
        const val MIRROR = "/v1.1/api/exhibition/mirrors/default"
        const val SESSION_ID = "12345678-1234-1234-1234-123456789abc"
        const val OTHER_SESSION_ID = "87654321-4321-4321-4321-cba987654321"
        const val REFERENCE_URL = "https://supplier-fixture.invalid/reference.png"
    }
}

private suspend fun CountDownLatch.awaitFixture() = withTimeout(5_000) { while (count > 0) delay(5) }
private fun HttpExchange.body() = JSONObject(requestBody.use { it.readBytes().toString(Charsets.UTF_8) })
private fun HttpExchange.json(value: JSONObject, status: Int = 200) = bytes(value.toString().toByteArray(), "application/json", status)
private fun HttpExchange.bytes(value: ByteArray, mime: String, status: Int = 200) {
    responseHeaders.set("Content-Type", mime)
    sendResponseHeaders(status, value.size.toLong())
    responseBody.use { it.write(value) }
}
