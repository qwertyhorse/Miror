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
        // Published materials must bind server-prepared assets, never fall back to SDK uploads.
        for (mode in listOf("clothx", "free", "mox")) for (prebound in listOf(false, true)) {
            RoundFixture(mode, ready = true, published = true, prebound = prebound, separateReference = true).use { fixture ->
                val controller = NativeXmaxController(fixture.events)
                val running = startRound(fixture, controller)
                try {
                    withTimeout(5_000) { running.firstFrame.await() }
                    verify(fixture.events.none { it == "upload" }, "Published material used a client upload")
                    verify(fixture.imagePaths.isEmpty() == (mode != "mox"), "Only MoX should download its photo input")
                    verify(controller.generatedReference == RoundFixture.REFERENCE_URL, "Published binding URL not used")
                    verify(fixture.events.contains("bind") != prebound, "Server-bound material was bound twice")
                    if (mode != "mox") {
                        val next = fixture.snapshot().put("generationNumber", 4).put("revision", 5)
                        withTimeout(5_000) { while (!running.round.canReuse(next, fixture.look)) delay(5) }
                        fixture.ready = false
                        running.round.update(next, fixture.look)
                        withTimeout(5_000) { while (running.errors.isEmpty()) delay(5) }
                        verify(running.round.isBusy && fixture.stoppedIds.isEmpty(), "Unavailable material reopened gestures or stopped RTC")
                        fixture.ready = true
                        verify(running.round.retryUpdate(), "Published material retry unavailable")
                        withTimeout(5_000) { while (!fixture.events.contains("condition-applied") || running.round.isBusy) delay(5) }
                        verify(fixture.events.none { it == "image" || it == "upload" }, "Published retry fell back to local upload")
                        verify(fixture.allocations.get() == 1 && fixture.events.count { it == "connect" } == 1,
                            "Published condition update reallocated or reconnected")
                    }
                    fixture.checkHandler()
                } finally { running.job.cancelAndJoin() }
            }
        }
        for (ready in listOf(false, true)) {
            RoundFixture("clothx", ready = ready, published = true, bindingAvailable = false).use { fixture ->
                val running = startRound(fixture, NativeXmaxController(fixture.events))
                try {
                    withTimeout(5_000) { running.failure.await(); running.job.join() }
                    verify(fixture.allocations.get() == 0, "Unavailable published binding allocated a credential")
                    verify(fixture.events.none { it in listOf("image", "upload", "connect", "generate") },
                        "Unavailable published binding fell back to local preparation")
                    verify(running.round.isBusy, "Unavailable published binding reopened gestures")
                    fixture.checkHandler()
                } finally { running.job.cancelAndJoin() }
            }
        }

        // Scope changes and expiration after allocation must stop the owned reservation,
        // including when the server already attached reference version 1.
        for (prebound in listOf(false, true)) for (expired in listOf(false, true)) {
            RoundFixture("clothx", ready = true, published = true, prebound = prebound,
                preparedScope = if (expired) "fixture-scope" else "stale-scope",
                referenceTtlMs = if (expired) 750 else 60_000, holdCreate = expired).use { fixture ->
                val running = startRound(fixture, NativeXmaxController(fixture.events))
                try {
                    if (expired) {
                        fixture.createEntered.awaitFixture()
                        withTimeout(5_000) { while (System.currentTimeMillis() <= fixture.referenceFreshUntil) delay(5) }
                        fixture.releaseCreate.countDown()
                    }
                    withTimeout(5_000) { running.failure.await(); running.job.join() }
                    verify(fixture.allocations.get() == 1 && fixture.stoppedIds.toList() == listOf(RoundFixture.SESSION_ID),
                        "Invalid published scope/freshness leaked or reallocated a reservation")
                    verify(fixture.events.none { it in listOf("bind", "image", "upload", "connect", "generate") },
                        "Invalid published scope/freshness reached binding or the supplier")
                    verify(running.round.isBusy && running.round.cleanupConfirmed, "Invalid binding reopened gestures or failed safe stop")
                    fixture.checkHandler()
                } finally { fixture.releaseCreate.countDown(); running.job.cancelAndJoin() }
            }
        }
        RoundFixture("clothx", ready = true, published = true, referenceTtlMs = -1).use { fixture ->
            val running = startRound(fixture, NativeXmaxController(fixture.events))
            try {
                withTimeout(5_000) { running.failure.await(); running.job.join() }
                verify(fixture.allocations.get() == 0 && fixture.stoppedIds.isEmpty(), "Already-expired binding allocated a credential")
                verify(running.round.isBusy && fixture.events.none { it in listOf("upload", "connect", "generate") },
                    "Already-expired binding reached generation or reopened gestures")
                fixture.checkHandler()
            } finally { running.job.cancelAndJoin() }
        }
        val invalidPrebound = listOf<Pair<String, (JSONObject) -> Unit>>(
            "reference URL" to { it.put("refImageUrl", "http://supplier-fixture.invalid/reference.png"); Unit },
            "reference asset" to { it.put("referenceAsset", "/assets/exhibition/another.png"); Unit },
            "owner metadata" to { it.getJSONObject("exhibition").put("deviceId", "another-device"); Unit },
            "reference version" to { it.put("referenceVersion", 2); Unit },
        )
        for ((label, mutation) in invalidPrebound) {
            RoundFixture("clothx", ready = true, published = true, mutateCreated = mutation).use { fixture ->
                val running = startRound(fixture, NativeXmaxController(fixture.events))
                try {
                    withTimeout(5_000) { running.failure.await(); running.job.join() }
                    verify(fixture.allocations.get() == 1 && fixture.stoppedIds.toList() == listOf(RoundFixture.SESSION_ID),
                        "Invalid prebound $label did not stop exactly its allocation")
                    verify(fixture.events.none { it in listOf("bind", "image", "upload", "connect", "generate") },
                        "Invalid prebound $label reached the supplier")
                    verify(running.round.isBusy && running.round.cleanupConfirmed, "Invalid prebound $label reopened or leaked resources")
                    fixture.checkHandler()
                } finally { running.job.cancelAndJoin() }
            }
        }
        RoundFixture("free", noReference = true, published = true, ready = false).use { fixture ->
            val controller = NativeXmaxController(fixture.events)
            val running = startRound(fixture, controller)
            try {
                withTimeout(5_000) { running.firstFrame.await(); while (running.round.isBusy) delay(5) }
                verify(controller.generatedReference == null && controller.generatedPrompt == "自定义提示词",
                    "Published Free prompt-only payload used a reference")
                verify(fixture.events.none { it in listOf("prepare-reference", "bind", "image", "upload") },
                    "Published Free prompt-only round consulted or uploaded its cover")
                verify(fixture.allocations.get() == 1, "Published Free prompt-only allocation count changed")
                fixture.checkHandler()
            } finally { running.job.cancelAndJoin() }
            verify(fixture.stoppedIds.toList() == listOf(RoundFixture.SESSION_ID) && running.round.isBusy,
                "Published Free prompt-only stop leaked or reopened gesture input")
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
                        verify(running.round.isBusy && running.busyTransitions.toList() == listOf(true),
                            "Gesture input reopened during preparation, connection or unacknowledged generation")
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
                verify(running.round.isBusy, "Stopped round reopened gesture input")
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
                verify(running.round.isBusy, "Failed preparation must remain blocked until retry succeeds")
                controller.failUpload = false
                verify(running.round.retryUpdate(), "Failed selection was not retryable")
                verify(running.round.isBusy, "Retry reopened before a server confirmation")
                withTimeout(5_000) { while (!fixture.events.contains("condition-applied")) delay(5) }
                withTimeout(5_000) { while (running.round.isBusy) delay(5) }
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

        // Manual choices still conflate while gestures remain blocked through upload,
        // SDK submission and the latest server acknowledgement.
        RoundFixture("clothx").use { fixture ->
            val controller = NativeXmaxController(fixture.events)
            val running = startRound(fixture, controller)
            try {
                withTimeout(5_000) { running.firstFrame.await(); while (running.round.isBusy) delay(5) }
                running.busyTransitions.clear()
                val next = fixture.snapshot().put("generationNumber", 4).put("revision", 5)
                val pending = JSONObject(fixture.look.toString()).put("image", "/assets/exhibition/second.png")
                controller.holdUpload = true
                fixture.holdConditionApplied = true
                running.round.update(next, pending)
                verify(running.round.isBusy, "Submission did not synchronously block gestures")
                withTimeout(5_000) { controller.uploadEntered.await() }
                verify(running.round.isBusy, "Upload reopened gestures")
                running.round.update(JSONObject(next.toString()).put("generationNumber", 5), fixture.look)
                fixture.conditionAppliedEntered.awaitFixture()
                verify(running.round.isBusy && running.busyTransitions.toList() == listOf(true),
                    "Superseded preparation or completed SDK call reopened before the latest server acknowledgement")
                fixture.releaseConditionApplied.countDown()
                withTimeout(5_000) { while (running.round.isBusy) delay(5) }
                verify(running.busyTransitions.toList() == listOf(true, false), "Latest acknowledgement did not reopen exactly once")
                verify(controller.uploadCancelled && fixture.events.count { it == "generate" } == 2,
                    "Manual latest-wins regression")
            } finally {
                fixture.releaseConditionApplied.countDown()
                running.job.cancelAndJoin()
            }
            verify(running.round.isBusy && running.busyTransitions.last(), "Stop did not close gesture input")
            fixture.checkHandler()
        }

        // An uncertain SDK result or rejected server acknowledgement must never
        // briefly clear isBusy while the error report/cleanup is in flight.
        for (failSdk in listOf(false, true)) {
            RoundFixture("clothx").use { fixture ->
                val controller = NativeXmaxController(fixture.events)
                val running = startRound(fixture, controller)
                try {
                    withTimeout(5_000) { running.firstFrame.await(); while (running.round.isBusy) delay(5) }
                    running.busyTransitions.clear()
                    fixture.holdErrorReport = true
                    fixture.failConditionApplied = !failSdk
                    controller.failGenerate = failSdk
                    running.round.update(fixture.snapshot().put("generationNumber", 4).put("revision", 5), fixture.look)
                    fixture.errorReportEntered.awaitFixture()
                    verify(running.round.isBusy && running.busyTransitions.toList() == listOf(true),
                        "Uncertain SDK/server result transiently reopened gesture input")
                    fixture.releaseErrorReport.countDown()
                    withTimeout(5_000) { running.failure.await(); running.job.join() }
                    verify(running.round.isBusy && running.busyTransitions.none { !it }, "Failure cleanup reopened gesture input")
                    fixture.checkHandler()
                } finally {
                    fixture.releaseErrorReport.countDown()
                    running.job.cancelAndJoin()
                }
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
                verify(!running.round.cleanupConfirmed, "Unconfirmed cloud stop allowed automatic reconnection")
                verify(running.callbackThreads.all { it == "fixture-main" }, "Cleanup error callback left Main")
                fixture.checkHandler()
            } finally { running.job.cancelAndJoin() }
        }
        RoundFixture("clothx").use { fixture ->
            val controller = NativeXmaxController(fixture.events)
            val running = startRound(fixture, controller)
            try {
                withTimeout(5_000) { running.firstFrame.await() }
                fixture.heartbeatFailures.set(1)
                withTimeout(8_000) { while (fixture.events.count { it == "heartbeat" } < 3) delay(20) }
                verify(!running.failure.isCompleted, "Transient heartbeat failure ended the round")
                verify(fixture.stoppedIds.isEmpty(), "Transient control failure stopped healthy video")
                verify(fixture.allocations.get() == 1, "Heartbeat recovery issued another credential")
                fixture.checkHandler()
            } finally { running.job.cancelAndJoin() }
        }
        RoundFixture("clothx", continuous = true, separateReference = true).use { fixture ->
            val controller = NativeXmaxController(fixture.events)
            val running = startRound(fixture, controller)
            try {
                withTimeout(5_000) { running.firstFrame.await() }
                withTimeout(8_000) { while (!fixture.events.contains("renewal-commit")) delay(20) }
                ordered(fixture.events, "renewal-prepare", "disconnect", "stop", "renewal-commit")
                verify(fixture.allocations.get() == 1, "Renewal allocated before confirmed handoff")
                verify(fixture.errorReports.get() == 0, "Planned renewal was reported as a failure")
                verify(controller.connectedCameraDeviceId == "usb-camera-fixture", "Renewal source lost exact camera identity")
                verify(fixture.imagePaths.toList() == listOf("/v1.1/assets/exhibition/reference.png"), "Renewal used display cover")
                fixture.checkHandler()
            } finally { running.job.cancelAndJoin() }
        }
        RoundFixture("clothx", continuous = true, stopConfirmed = false).use { fixture ->
            val running = startRound(fixture, NativeXmaxController(fixture.events))
            try {
                withTimeout(8_000) { running.failure.await(); running.job.join() }
                ordered(fixture.events, "renewal-prepare", "disconnect", "stop")
                verify(!fixture.events.contains("renewal-commit"), "Renewal committed before old session stopped")
                verify(!running.round.cleanupConfirmed, "Failed renewal stop was considered confirmed")
                verify(fixture.allocations.get() == 1, "Failed renewal stop issued another credential")
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
    val busyTransitions: MutableList<Boolean>,
)

private fun CoroutineScope.startRound(fixture: RoundFixture, controller: NativeXmaxController): RunningRound {
    val firstFrame = CompletableDeferred<Unit>()
    val failure = CompletableDeferred<Throwable>()
    val errors = CopyOnWriteArrayList<String>()
    val threads = CopyOnWriteArrayList<String>()
    val busy = CopyOnWriteArrayList<Boolean>().apply { add(true) }
    lateinit var round: NativeGenerationRound
    round = NativeGenerationRound(
        fixture.api, "default", "device-fixture", fixture.snapshot(), fixture.look,
        controller, onStatus = { threads.add(Thread.currentThread().name) },
        onError = { threads.add(Thread.currentThread().name); errors.add(it) },
        onFirstFrame = { threads.add(Thread.currentThread().name); fixture.events.add("ui-first"); firstFrame.complete(Unit) },
        cameraPosition = CameraPosition.FRONT,
        cameraDeviceId = "usb-camera-fixture",
        onBusyChanged = { busy.add(round.isBusy) },
    )
    val job = launch {
        try { round.run() }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Throwable) { failure.complete(error) }
    }
    return RunningRound(round, job, firstFrame, failure, errors, threads, busy)
}

private class RoundFixture(
    mode: String,
    noReference: Boolean = false,
    val holdFirstFrame: Boolean = false,
    private val holdCreate: Boolean = false,
    private val recoveryOtherOwner: Boolean = false,
    private val stopConfirmed: Boolean = true,
    @Volatile var ready: Boolean = false,
    private val published: Boolean = false,
    private val prebound: Boolean = true,
    private val bindingAvailable: Boolean = true,
    private val preparedScope: String = "fixture-scope",
    private val referenceTtlMs: Long = 60_000,
    private val mutateCreated: ((JSONObject) -> Unit)? = null,
    separateReference: Boolean = false,
    expiry: String = Instant.now().plusSeconds(120).toString(),
    private val continuous: Boolean = false,
) : AutoCloseable {
    val events = CopyOnWriteArrayList<String>()
    val imagePaths = CopyOnWriteArrayList<String>()
    val allocations = AtomicInteger()
    val errorReports = AtomicInteger()
    val heartbeatFailures = AtomicInteger()
    val stoppedIds = CopyOnWriteArrayList<String>()
    val createEntered = CountDownLatch(1)
    val releaseCreate = CountDownLatch(1)
    @Volatile var referenceFreshUntil = 0L
        private set
    val firstFrameEntered = CountDownLatch(1)
    val releaseFirstFrame = CountDownLatch(1)
    @Volatile var holdConditionApplied = false
    @Volatile var failConditionApplied = false
    @Volatile var holdErrorReport = false
    val conditionAppliedEntered = CountDownLatch(1)
    val releaseConditionApplied = CountDownLatch(1)
    val errorReportEntered = CountDownLatch(1)
    val releaseErrorReport = CountDownLatch(1)
    val imageBytes = byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10)
    val look = JSONObject().put("id", "commute").put("mode", mode)
        .put("referenceKind", if (noReference) "none" else "image")
        .put("image", "/assets/exhibition/commute-cutout.png").put("prompt", "  自定义提示词  ")
        .apply { if (separateReference) put("referenceImage", "/assets/exhibition/reference.png") }
    private val state = JSONObject().put("providerMode", "xmax").put("phase", "generating")
        .put("experienceMode", mode).put("selectedLookId", "commute").put("sessionNumber", 2)
        .put("generationNumber", 3).put("revision", 4).put("live", JSONObject.NULL)
        .apply { if (published) put("publication", JSONObject().put("revision", 1)) }
    private val record = JSONObject().put("id", SESSION_ID).put("status", "active")
        .put("sourceKind", if (mode == "mox") "photo" else "camera")
        .put("referenceAsset", if (noReference) "" else if (separateReference) "/assets/exhibition/reference.png" else look.getString("image"))
        .put("referenceScope", "fixture-scope").put("referenceVersion", 0).put("refImageUrl", "").put("providerRegion", "cn")
        .put("expiresAt", expiry)
        .put("exhibition", JSONObject().put("mirrorId", "default").put("deviceId", "device-fixture")
            .put("lookId", "commute").put("mode", mode).put("prompt", NativeRoundMetadata.prompt(look))
            .put("sessionNumber", 2).put("generationNumber", 3).put("continuous", continuous))
        .apply { if (published && prebound && !noReference) put("referenceVersion", 1).put("refImageUrl", REFERENCE_URL) }
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
                if (published) check(exchange.requestHeaders.getFirst("X-Miror-Material") == "binding-v1")
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
                mutateCreated?.invoke(created)
                // A cancelled request intentionally discards this reply after allocation.
                try { exchange.json(created, 201) } catch (error: Exception) { if (!holdCreate) throw error }
            }
            path == "$MIRROR/references/commute" -> {
                events.add("prepare-reference")
                referenceFreshUntil = System.currentTimeMillis() + referenceTtlMs
                exchange.json(JSONObject().put("reference", if (ready)
                    JSONObject().put("url", REFERENCE_URL).put("scope", preparedScope).put("freshUntil", referenceFreshUntil)
                        .apply { if (bindingAvailable) put("bindingId", "binding-fixture") }
                    else JSONObject.NULL))
            }
            path == "$MIRROR/live/session/$SESSION_ID/condition" -> {
                val body = exchange.body()
                check(body.getLong("generationNumber") in 4L..5L && body.optString("refImageUrl", REFERENCE_URL) == REFERENCE_URL)
                if (published) check(body.optString("bindingId") == "binding-fixture" && !body.has("refImageUrl"))
                val bound = synchronized(lock) {
                    record.put("refImageUrl", if (published) REFERENCE_URL else body.optString("refImageUrl"))
                    record.getJSONObject("exhibition").put("generationNumber", body.getLong("generationNumber"))
                    record.put("referenceVersion", 2); JSONObject(record.toString())
                }
                events.add("condition"); exchange.json(bound)
            }
            path == "$MIRROR/live/session/$SESSION_ID/condition/applied" -> {
                check(exchange.body().getLong("referenceVersion") == 2L)
                conditionAppliedEntered.countDown()
                if (holdConditionApplied) check(releaseConditionApplied.await(5, TimeUnit.SECONDS))
                if (failConditionApplied) exchange.json(JSONObject().put("message", "切换确认失败"), 503)
                else { events.add("condition-applied"); exchange.json(snapshot()) }
            }
            path == "$MIRROR/live/heartbeat" -> {
                events.add("heartbeat")
                // A failed/cancelled round cancels its concurrent heartbeat request.
                // Only its response write may be discarded; fixture assertions still fail.
                val fails = heartbeatFailures.getAndUpdate { if (it > 0) it - 1 else 0 } > 0
                val reply = if (fails) JSONObject().put("code", "TEMPORARY_ERROR").put("message", "Temporary failure")
                    else snapshot().also {
                        if (continuous && events.contains("report-first")) it.optJSONObject("live")?.put("renewalDue", true)
                    }
                try { exchange.json(reply, if (fails) 503 else 200) } catch (_: java.io.IOException) { }
            }
            path == "$MIRROR/live/session/$SESSION_ID/renewal" -> {
                events.add("renewal-prepare"); exchange.json(JSONObject().put("renewalId", "fixture-renewal"))
            }
            path == "$MIRROR/live/session/$SESSION_ID/renewal/commit" -> {
                check(events.contains("disconnect") && stoppedIds.contains(SESSION_ID))
                events.add("renewal-commit"); exchange.json(snapshot())
            }
            path == "$MIRROR/live/session/$SESSION_ID/reference" -> {
                val body = exchange.body()
                check(body.getString("deviceId") == "device-fixture" && body.getString("lookId") == "commute")
                if (published) check(body.optString("bindingId") == "binding-fixture" && !body.has("refImageUrl"))
                else check(body.getString("refImageUrl") == REFERENCE_URL)
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
                errorReports.incrementAndGet(); events.add("report-error"); errorReportEntered.countDown()
                if (holdErrorReport) check(releaseErrorReport.await(5, TimeUnit.SECONDS))
                exchange.json(snapshot())
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
        releaseConditionApplied.countDown(); releaseErrorReport.countDown()
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
