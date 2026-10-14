package ai.openbuy.exhibition

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Standalone JVM integration contract test. All requests go to a disposable local fixture. */
fun main() = runBlocking {
    val executor = Executors.newCachedThreadPool()
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    server.executor = executor
    val received = AtomicInteger()
    val handler = AtomicReference<(HttpExchange) -> Unit>({ it.reply(JSONObject()) })
    server.createContext("/") { exchange ->
        received.incrementAndGet()
        try { handler.get()(exchange) } finally { exchange.close() }
    }
    server.start()
    val origin = "http://127.0.0.1:${server.address.port}"
    val token = "fixture-device-credential-0123456789"
    val terminal = "terminal-12345678-1234-1234-1234-123456789abc"
    val session = "12345678-1234-1234-1234-123456789abc"
    val api = ExhibitionApi("$origin/v1.1/exhibition/screen?mirror=default", terminal, token, "测试智能镜")
    val mirrorPath = "/v1.1/api/exhibition/mirrors/default"
    var assertions = 0
    fun verify(value: Boolean, message: String) { check(value) { message }; assertions++ }
    suspend fun failure(code: String, block: suspend () -> Unit) {
        try { block(); error("Expected $code") } catch (error: ExhibitionApiException) {
            verify(error.code == code, "Unexpected error code: ${error.code}")
        }
    }
    try {
        verify(api.assetUrl("/assets/exhibition/commute-cutout.png") == "$origin/v1.1/assets/exhibition/commute-cutout.png", "Sample must use V1.1")
        verify(api.assetUrl("/api/exhibition/mirrors/default/assets/upload-a") == "$origin$mirrorPath/assets/upload-a", "Upload must use V1.1")
        verify(api.assetUrl("$origin/v1.1/assets/a.png") == "$origin/v1.1/assets/a.png", "Version must not be doubled")
        for (invalid in listOf("https://outside.invalid/a.png", "//outside.invalid/a.png", "/v1.0/assets/a.png",
            "/assets/../a.png", "/assets/%2e%2e/a.png", "/assets/%5c..%5ca.png", "file:///a.png", "/assets/a.png#x")) {
            try { api.assetUrl(invalid); error("Accepted unsafe asset path") } catch (_: IllegalArgumentException) { assertions++ }
        }
        handler.set { exchange ->
            verify(exchange.requestURI.path == "/v1.1/api/exhibition/terminals/connect", "Terminal endpoint")
            verify(exchange.requestMethod == "POST", "Terminal method")
            verify(exchange.requestHeaders.getFirst("Origin") == origin, "Same-origin header")
            verify(exchange.requestHeaders.getFirst("X-Miror-Protocol") == "2", "Native lifecycle protocol")
            verify(exchange.requestHeaders.getFirst("Cache-Control") == "no-store", "No cache")
            verify(exchange.requestHeaders.getFirst("Content-Type").startsWith("application/json"), "JSON body")
            val body = exchange.jsonBody()
            verify(body.getString("terminalId") == terminal && body.getString("token") == token, "Persistent identity")
            verify(body.getString("platform") == "android", "Native platform")
            verify(body.getJSONObject("cameraCapabilities").getInt("version") == 1, "Camera management capability")
            verify(!body.has("cameraReport"), "Initial poll does not invent a camera binding or report")
            exchange.reply(JSONObject().put("terminalId", terminal).put("mirrorId", "default"))
        }
        verify(api.connectTerminal().getString("mirrorId") == "default", "Binding response")
        val cameraReport = JSONObject().put("mirrorId", "default").put("bindingId", "binding-fixture")
            .put("requestId", "camera-fixture").put("status", "preview").put("devices", org.json.JSONArray())
            .put("selectedDeviceId", "usb-42").put("activeDeviceId", "usb-42")
        handler.set { exchange ->
            val body = exchange.jsonBody()
            verify(body.getString("terminalId") == terminal && body.getString("token") == token, "Camera report uses authenticated terminal poll")
            verify(body.getJSONObject("cameraReport").toString() == cameraReport.toString(), "Camera metadata contract remains intact")
            exchange.reply(JSONObject().put("cameraBindingId", "binding-fixture").put("cameraReportAccepted", true)
                .put("cameraRequest", JSONObject().put("id", "camera-fixture").put("action", "open")))
        }
        val cameraBinding = api.connectTerminal(cameraReport)
        verify(cameraBinding.getBoolean("cameraReportAccepted") && cameraBinding.getJSONObject("cameraRequest").getString("action") == "open",
            "Poll returns diagnostic request and acknowledgement")
        handler.set { exchange ->
            verify(exchange.requestURI.path == mirrorPath && exchange.requestMethod == "GET", "State endpoint")
            exchange.reply(JSONObject().put("revision", 7))
        }
        verify(api.state("default").getLong("revision") == 7L, "State response")
        handler.set { exchange ->
            verify(exchange.requestURI.path == "$mirrorPath/live/status", "Live status endpoint")
            exchange.reply(JSONObject().put("configured", true))
        }
        verify(api.liveStatus("default").getBoolean("configured"), "Live status response")
        val commandIds = mutableSetOf<String>()
        handler.set { exchange ->
            verify(exchange.requestURI.path == "$mirrorPath/command", "Command endpoint")
            val body = exchange.jsonBody()
            verify(commandIds.add(body.getString("commandId")) &&
                java.util.UUID.fromString(body.getString("commandId")).toString() == body.getString("commandId"),
                "Each command has a distinct UUID")
            if (body.getString("action") == "end") verify(!body.has("expectedRevision"), "Stop bypasses stale revision")
            else verify(body.getLong("expectedRevision") == 7L && body.getString("lookId") == "commute", "Select revision and look")
            exchange.reply(JSONObject())
        }
        api.command("default", "select", 7, "commute")
        api.command("default", "end", 7)
        handler.set { exchange ->
            verify(exchange.requestURI.path == "$mirrorPath/live/session", "Create endpoint")
            val body = exchange.jsonBody()
            verify(body.getString("terminalId") == terminal && body.getString("terminalToken") == token, "Allocation owner credentials")
            verify(body.getLong("generationNumber") == 9L && body.getLong("expectedRevision") == 7L, "Allocation generation")
            verify(body.getString("deviceId") == "device-fixture" && body.getString("lookId") == "commute", "Allocation identity")
            exchange.reply(JSONObject().put("id", session).put("token", "tk-fixture"), 201)
        }
        verify(api.createSession("default", "device-fixture", "commute", 9, 7).getString("id") == session, "Allocation response")
        handler.set { exchange ->
            verify(exchange.requestURI.path == "$mirrorPath/live/session/$session/reference", "Reference endpoint")
            val body = exchange.jsonBody()
            verify(body.getString("deviceId") == "device-fixture" && body.getString("lookId") == "commute", "Reference owner")
            verify(body.getString("refImageUrl") == "https://fixture.invalid/garment.png", "Reference URL")
            exchange.reply(JSONObject().put("referenceVersion", 1))
        }
        api.bindReference("default", session, "device-fixture", "commute", "https://fixture.invalid/garment.png")
        handler.set { exchange ->
            val body = exchange.jsonBody()
            when (exchange.requestURI.path) {
                "$mirrorPath/sessions/$session/link" -> verify(body.getString("providerSessionId") == "ums-fixture", "HTTP supplier session ID")
                "$mirrorPath/sessions/$session/first-frame" -> verify(body.getLong("firstFrameMs") == 123L, "Remote first frame duration")
                "$mirrorPath/live/heartbeat" -> verify(body.getString("sessionId") == session && body.getString("deviceId") == "device-fixture", "Local heartbeat ownership")
                else -> error("Unexpected endpoint")
            }
            exchange.reply(JSONObject())
        }
        api.link("default", session, "ums-fixture")
        api.firstFrame("default", session, 123)
        api.heartbeat("default", session, "device-fixture")
        handler.set { exchange ->
            verify(exchange.requestMethod == "POST", "Renewal uses POST")
            verify(exchange.requestHeaders.getFirst("X-Miror-Protocol") == "2", "Renewal lifecycle protocol")
            val body = exchange.jsonBody()
            verify(body.getString("deviceId") == "device-fixture", "Renewal owner")
            when (exchange.requestURI.path) {
                "$mirrorPath/live/session/$session/renewal" -> {
                    verify(body.getLong("sessionNumber") == 2L && body.getLong("generationNumber") == 9L, "Renewal generation")
                    exchange.reply(JSONObject().put("renewalId", "renewal-fixture"))
                }
                "$mirrorPath/live/session/$session/renewal/commit" -> {
                    verify(body.getString("renewalId") == "renewal-fixture", "Renewal confirmation identity")
                    exchange.reply(JSONObject().put("generationNumber", 10))
                }
                else -> error("Unexpected renewal endpoint")
            }
        }
        verify(api.prepareRenewal("default", session, "device-fixture", 2, 9).getString("renewalId") == "renewal-fixture",
            "Renewal plan response")
        verify(api.commitRenewal("default", session, "device-fixture", "renewal-fixture").getLong("generationNumber") == 10L,
            "Renewal confirmation response")
        handler.set { exchange ->
            verify(exchange.requestURI.path == "$mirrorPath/sessions/$session/stop", "Stop endpoint")
            exchange.reply(JSONObject().put("status", "stopping"))
        }
        failure("STOP_NOT_CONFIRMED") { api.stopSession("default", session) }
        handler.set { it.reply(JSONObject().put("status", "stopped")) }
        verify(api.stopSession("default", session).getString("status") == "stopped", "Confirmed stop")
        handler.set { exchange ->
            verify(exchange.requestURI.path == "$mirrorPath/live/error", "Error endpoint")
            val body = exchange.jsonBody()
            verify(body.getLong("sessionNumber") == 2L && body.getLong("generationNumber") == 9L, "Error generation")
            verify(body.getString("reason") == "lease_expired", "Recovery reason reaches backend")
            verify(!body.getString("message").contains(token) && !body.getString("message").contains("tk-fixture")
                && !body.getString("message").contains("https://"), "Error report redacts credentials and URLs")
            exchange.reply(JSONObject())
        }
        api.reportError("default", "device-fixture", session, "commute", 2, 9,
            "Error $token tk-fixture https://fixture.invalid/?key=secret", "lease_expired")
        handler.set { exchange ->
            exchange.reply(JSONObject().put("error", JSONObject().put("code", "EXHIBITION_STALE_REVISION")
                .put("message", "状态已更新 tk-fixture $token")), 409)
        }
        try { api.state("default"); error("Expected HTTP error") } catch (error: ExhibitionApiException) {
            verify(error.code == "EXHIBITION_STALE_REVISION" && error.status == 409, "Structured API error")
            verify(!error.message.orEmpty().contains(token) && !error.message.orEmpty().contains("tk-fixture"), "Error text redaction")
        }
        handler.set { exchange ->
            exchange.responseHeaders.set("Location", "https://outside.invalid/")
            exchange.sendResponseHeaders(302, -1)
        }
        failure("BACKEND_REDIRECT") { api.connectTerminal() }
        val requestsBeforeDisconnect = received.get()
        handler.set { exchange ->
            // A lost reply must not cause OkHttp to repeat a paid allocation POST.
            exchange.requestBody.use { it.readBytes() }
        }
        failure("NETWORK_ERROR") { api.createSession("default", "device-fixture", "commute", 9, 7) }
        verify(received.get() == requestsBeforeDisconnect + 1, "Lost allocation reply must not be retried")
        handler.set { exchange -> exchange.bytes(byteArrayOf(1, 2, 3), "image/webp") }
        verify(api.image("/assets/fixture.webp").contentEquals(byteArrayOf(1, 2, 3)), "Image bytes")
        handler.set { exchange -> exchange.bytes(byteArrayOf(1), "text/html") }
        failure("INVALID_IMAGE") { api.image("/assets/fixture.webp") }
        handler.set { exchange ->
            exchange.responseHeaders.set("Content-Type", "image/png")
            exchange.sendResponseHeaders(200, 64L * 1024 * 1024 + 1)
        }
        failure("IMAGE_TOO_LARGE") { api.image("/assets/fixture.png") }
        val callsBeforeInvalid = received.get()
        try { api.state("../settings"); error("Expected invalid mirror") } catch (_: IllegalArgumentException) { assertions++ }
        verify(callsBeforeInvalid == received.get(), "Invalid IDs rejected before I/O")
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        handler.set { exchange ->
            entered.countDown()
            release.await(5, TimeUnit.SECONDS)
            try { exchange.reply(JSONObject()) } catch (_: Exception) { /* Caller has disconnected. */ }
        }
        val pending = async { api.state("default") }
        while (entered.count > 0L) delay(5)
        val start = System.nanoTime()
        pending.cancel()
        release.countDown()
        pending.cancelAndJoin()
        verify(pending.isCancelled && TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) < 2_000, "Cancellation disconnects request")
        println("ExhibitionApi contract passed: $assertions assertions; no live service or generation calls.")
    } finally {
        server.stop(0)
        executor.shutdownNow()
    }
}

private fun HttpExchange.jsonBody() = JSONObject(requestBody.use { it.readBytes().toString(Charsets.UTF_8) })
private fun HttpExchange.reply(value: JSONObject, status: Int = 200) = bytes(value.toString().toByteArray(Charsets.UTF_8), "application/json", status)
private fun HttpExchange.bytes(value: ByteArray, mime: String, status: Int = 200) {
    responseHeaders.set("Content-Type", mime)
    sendResponseHeaders(status, value.size.toLong())
    responseBody.use { it.write(value) }
}
