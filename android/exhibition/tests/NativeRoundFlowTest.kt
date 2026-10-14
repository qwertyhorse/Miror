package ai.openbuy.exhibition

import ai.xmax.sdk.CameraPosition
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
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
        // Numeric offsets occur in real XMAX replies; exercise every metadata receipt.
        for (offset in listOf("+00:00", "+08:00", "-05:30")) {
            val expiry = Instant.now().plusSeconds(120).atOffset(ZoneOffset.of(offset))
                .format(DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSSxxx"))
            RoundFixture("clothx", expiry = expiry).use { fixture ->
                val running = startRound(fixture, NativeXmaxController(fixture.events))
                try {
                    withTimeout(5_000) { running.firstFrame.await() }
                    ordered(fixture.events, "create", "bind", "connect", "link", "report-first", "ui-first")
                    verify(!running.failure.isCompleted && running.errors.isEmpty(), "Valid offset expiry failed")
                } finally { running.job.cancelAndJoin() }
                verify(fixture.allocations.get() == 1 && fixture.stoppedIds.toList() == listOf(RoundFixture.SESSION_ID),
                    "Offset expiry duplicated or leaked a reservation")
                fixture.checkHandler()
            }
        }
        for ((expiry, message) in listOf(
            "invalid" to "体验有效期无效。",
            "2000-01-01T08:00:00.000+08:00" to "本次体验已过期，请重试。",
        )) {
            RoundFixture("clothx", expiry = expiry).use { fixture ->
                val running = startRound(fixture, NativeXmaxController(fixture.events))
                try {
                    withTimeout(5_000) { running.failure.await(); running.job.join() }
                    verify(running.errors.toList() == listOf(message), "Invalid and expired timestamps conflated")
                    verify(fixture.events.none { it in listOf("upload", "bind", "connect", "generate", "ui-first") },
                        "Invalid expiry reached the supplier")
                    verify(fixture.allocations.get() == 1 && fixture.errorReports.get() == 1,
                        "Invalid expiry reallocated or skipped reporting")
                    verify(fixture.stoppedIds.toList() == listOf(RoundFixture.SESSION_ID)
                        && fixture.events.contains("disconnect"), "Invalid expiry did not release its reservation")
                    fixture.checkHandler()
                } finally { running.job.cancelAndJoin() }
            }
        }
        // Legacy and separate-image catalogs exercise each supported input shape.
        for (mode in listOf("clothx", "free", "mox")) for (separateReference in listOf(false, true)) {
            RoundFixture(mode, noReference = mode == "free", holdFirstFrame = mode == "clothx", separateReference = separateReference).use { fixture ->
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
                        verify(fixture.imagePaths.isEmpty(), "Free none fetched a material image")
                        verify(controller.generatedPrompt == "自定义提示词" && controller.generatedReference == null, "Free prompt-only payload")
                    } else {
                        ordered(fixture.events, "image", "create", "upload", "bind", "connect", "link", "generate", "remote-frame", "report-first", "ui-first")
                        verify(controller.uploadedBytes!!.contentEquals(fixture.imageBytes), "Downloaded reference was not uploaded")
                        verify(controller.uploadedMime == "image/png", "Image MIME did not match its bytes")
                        verify(controller.generatedReference == RoundFixture.REFERENCE_URL, "Generation used an unbound reference")
                        verify(fixture.imagePaths.toList() == listOf("/v1.1" + if (separateReference) "/assets/exhibition/reference.png" else "/assets/exhibition/commute-cutout.png"), "Generation fetched a display cover instead of its reference")
                    }
                    verify((controller.connectedImage != null) == (mode == "mox"), "MoX/photo versus camera source")
                    if (mode == "mox") verify(controller.connectedImage!!.contentEquals(fixture.imageBytes), "MoX did not use the selected image")
                    verify(controller.connectedPosition == CameraPosition.FRONT, "Camera selection was lost")
                    verify(controller.connectedCameraDeviceId == (if (mode == "mox") null else "usb-camera-fixture"),
                        "Selected camera device ID was lost or sent to image input")
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

        for (sameReference in listOf(false, true)) {
            RoundFixture("clothx", separateReference = true).use { fixture ->
                val controller = NativeXmaxController(fixture.events)
                val running = startRound(fixture, controller)
                try {
                    withTimeout(5_000) { running.firstFrame.await() }
                    val next = fixture.snapshot().put("generationNumber", 4).put("revision", 5)
                    val secondLook = JSONObject(fixture.look.toString()).put("image", "/assets/exhibition/another-cover.png")
                        .put("referenceImage", if (sameReference) "/assets/exhibition/reference.png" else "/assets/exhibition/second-reference.png")
                    withTimeout(5_000) { while (!running.round.canReuse(next, secondLook)) delay(5) }
                    fixture.referenceAsset(secondLook.getString("referenceImage"))
                    running.round.update(next, secondLook)
                    withTimeout(5_000) { while (!fixture.events.contains("condition-applied")) delay(5) }
                    val expectedImages = mutableListOf("/v1.1/assets/exhibition/reference.png")
                    if (!sameReference) expectedImages.add("/v1.1/assets/exhibition/second-reference.png")
                    verify(fixture.imagePaths.toList() == expectedImages, "Continuous reference cache used display covers")
                    verify(fixture.events.count { it == "upload" } == expectedImages.size, "Continuous selection uploaded the wrong reference")
                    verify(fixture.allocations.get() == 1 && fixture.events.count { it == "connect" } == 1, "Separate-image selection reconnected")
                    verify(running.errors.isEmpty(), "Separate-image condition failed its session check")
                    fixture.checkHandler()
                } finally { running.job.cancelAndJoin() }
            }
        }

        for (ready in listOf(false, true)) {
            RoundFixture("clothx", ready = ready).use { fixture ->
                val controller = NativeXmaxController(fixture.events)
                val running = startRound(fixture, controller)
                try {
                    withTimeout(5_000) { running.firstFrame.await() }
                    if (ready) verify(fixture.events.none { it == "upload" || it == "image" }, "Prepared reference still uploaded")
                    val next = fixture.snapshot().put("generationNumber", 4).put("revision", 5)
                    withTimeout(5_000) { while (!running.round.canReuse(next, fixture.look)) delay(5) }
                    running.round.update(next, fixture.look)
                    withTimeout(5_000) { while (!fixture.events.contains("condition-applied")) delay(5) }
                    verify(fixture.allocations.get() == 1 && fixture.events.count { it == "connect" } == 1, "Continuous update reallocated/reconnected")
                    verify(fixture.events.count { it == "generate" } == 2, "Continuous update was not sent")
                    verify(fixture.events.count { it == "report-first" } == 1, "Condition update reported a second first frame")
                    verify(fixture.stoppedIds.isEmpty(), "Selection stopped the active connection")
                    verify(!running.round.canReuse(JSONObject(next.toString()).put("sessionNumber", 3), fixture.look), "New experience reused old lease")
                    verify(!running.round.canReuse(JSONObject(next.toString()).put("experienceMode", "mox"), JSONObject(fixture.look.toString()).put("mode", "mox")), "Mode change reused old RTC")
                    fixture.checkHandler()
                } finally { running.job.cancelAndJoin() }
                verify(fixture.stoppedIds.size == 1, "Continuous experience did not stop exactly once")
            }
        }

        RoundFixture("clothx").use { fixture ->
            val controller = NativeXmaxController(fixture.events)
            val running = startRound(fixture, controller)
            try {
                withTimeout(5_000) { running.firstFrame.await() }
                val next = fixture.snapshot().put("generationNumber", 4).put("revision", 5)
                val secondLook = JSONObject(fixture.look.toString()).put("image", "/assets/exhibition/second.png")
                withTimeout(5_000) { while (!running.round.canReuse(next, secondLook)) delay(5) }
                controller.failUpload = true
                fixture.referenceAsset(secondLook.getString("image"))
                running.round.update(next, secondLook)
                withTimeout(5_000) { while (running.errors.isEmpty()) delay(5) }
                verify(fixture.stoppedIds.isEmpty() && !running.failure.isCompleted, "Upload failure tore down RTC")
                controller.failUpload = false
                verify(running.round.retryUpdate(), "Failed selection was not retryable")
                withTimeout(5_000) { while (!fixture.events.contains("condition-applied")) delay(5) }
                verify(fixture.allocations.get() == 1, "Retry allocated a new temporary credential")
                fixture.checkHandler()
            } finally { running.job.cancelAndJoin() }
        }
        RoundFixture("clothx").use { fixture ->
            val controller = NativeXmaxController(fixture.events)
            val running = startRound(fixture, controller)
            try {
                withTimeout(5_000) { running.firstFrame.await() }
                val next = fixture.snapshot().put("generationNumber", 4).put("revision", 5)
                val pendingLook = JSONObject(fixture.look.toString()).put("image", "/assets/exhibition/second.png")
                withTimeout(5_000) { while (!running.round.canReuse(next, pendingLook)) delay(5) }
                controller.holdUpload = true
                running.round.update(next, pendingLook)
                withTimeout(5_000) { controller.uploadEntered.await() }
                running.round.update(JSONObject(next.toString()).put("generationNumber", 5), fixture.look)
                withTimeout(5_000) { while (!fixture.events.contains("condition-applied")) delay(5) }
                verify(fixture.events.count { it == "generate" } == 2, "Obsolete upload generated an extra outfit")
                verify(controller.uploadCancelled, "Obsolete upload was not cancelled")
                verify(fixture.stoppedIds.isEmpty() && running.errors.isEmpty(), "Superseded upload stopped or failed experience")
                fixture.checkHandler()
            } finally { running.job.cancelAndJoin() }
        }

        RoundFixture("free").use { fixture ->
            val controller = NativeXmaxController(fixture.events)
            val running = startRound(fixture, controller)
            try {
                withTimeout(5_000) { running.firstFrame.await() }
                val next = fixture.snapshot().put("generationNumber", 4).put("revision", 5)
                val promptOnly = JSONObject(fixture.look.toString()).put("referenceKind", "none")
                withTimeout(5_000) { while (!running.round.canReuse(next, promptOnly)) delay(5) }
                fixture.referenceAsset("")
                running.round.update(next, promptOnly)
                withTimeout(5_000) { while (!fixture.events.contains("condition-applied")) delay(5) }
                verify(controller.generatedReference == null, "Free prompt-only selection retained previous reference")
                verify(fixture.events.count { it == "upload" } == 1, "Free prompt-only selection uploaded its cover")
                verify(fixture.allocations.get() == 1, "Free condition change allocated a new key")
                fixture.checkHandler()
            } finally { running.job.cancelAndJoin() }
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
        println("Native round flow passed: $assertions assertions; no supplier SDK or live service calls.")
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
        cameraDeviceId = "usb-camera-fixture",
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
    private val ready: Boolean = false,
    separateReference: Boolean = false,
    expiry: String = Instant.now().plusSeconds(120).toString(),
) : AutoCloseable {
    val events = CopyOnWriteArrayList<String>()
    val imagePaths = CopyOnWriteArrayList<String>()
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
        .apply { if (separateReference) put("referenceImage", "/assets/exhibition/reference.png") }
    private val state = JSONObject().put("providerMode", "xmax").put("phase", "generating")
        .put("experienceMode", mode).put("selectedLookId", "commute").put("sessionNumber", 2)
        .put("generationNumber", 3).put("revision", 4).put("live", JSONObject.NULL)
    private val record = JSONObject().put("id", SESSION_ID).put("status", "active")
        .put("sourceKind", if (mode == "mox") "photo" else "camera")
        .put("referenceAsset", if (noReference) "" else if (separateReference) "/assets/exhibition/reference.png" else look.getString("image"))
        .put("referenceScope", "fixture-scope").put("referenceVersion", 0).put("refImageUrl", "").put("providerRegion", "cn")
        .put("expiresAt", expiry)
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
    fun referenceAsset(path: String) = synchronized(lock) { record.put("referenceAsset", path) }
    fun snapshot() = synchronized(lock) { JSONObject(state.toString()) }
    fun checkHandler() { failure.get()?.let { throw AssertionError("Local fixture handler failed", it) } }

    private fun handle(exchange: HttpExchange) {
        val path = exchange.requestURI.path
        when {
            path.startsWith("/v1.1/assets/exhibition/") -> {
                imagePaths.add(path); events.add("image"); exchange.bytes(imageBytes, "image/png")
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
            path == "$MIRROR/references/commute" -> exchange.json(JSONObject().put("reference", if (ready)
                JSONObject().put("url", REFERENCE_URL).put("scope", "fixture-scope").put("freshUntil", System.currentTimeMillis() + 60_000)
                else JSONObject.NULL))
            path == "$MIRROR/live/session/$SESSION_ID/condition" -> {
                val body = exchange.body()
                check(body.getLong("generationNumber") in 4L..5L && body.optString("refImageUrl", REFERENCE_URL) == REFERENCE_URL)
                val bound = synchronized(lock) {
                    record.put("refImageUrl", body.optString("refImageUrl"))
                    record.getJSONObject("exhibition").put("generationNumber", body.getLong("generationNumber"))
                    record.put("referenceVersion", 2); JSONObject(record.toString())
                }
                events.add("condition"); exchange.json(bound)
            }
            path == "$MIRROR/live/session/$SESSION_ID/condition/applied" -> {
                check(exchange.body().getLong("referenceVersion") == 2L)
                events.add("condition-applied"); exchange.json(snapshot())
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
