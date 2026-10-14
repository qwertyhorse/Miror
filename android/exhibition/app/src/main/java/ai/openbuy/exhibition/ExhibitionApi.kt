package ai.openbuy.exhibition

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Dns
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.SocketTimeoutException
import java.net.URI
import java.net.UnknownHostException
import java.util.Locale
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** The native terminal uses the same version-scoped LAN API as the mirror page. */
class ExhibitionApi(
    screenUrl: String,
    private val terminalId: String,
    private val terminalToken: String,
    private val label: String,
    dns: Dns = Dns.SYSTEM,
) {
    private val screen = URI(UrlPolicy.cameraScreenUrl(screenUrl))
    private val origin: String
    // Keep the configured hostname for Host, SNI and certificate verification.
    // DNS may supply a LAN address; paid POSTs must never be retried automatically.
    private val client = OkHttpClient.Builder().dns(dns)
        .retryOnConnectionFailure(false).followRedirects(false).followSslRedirects(false).build()

    init {
        require(screen.rawPath == SCREEN_PATH || screen.rawPath == "$SCREEN_PATH/") {
            "请填写 V1.1 镜端网址。"
        }
        origin = "${screen.scheme}://${screen.rawAuthority}"
    }

    /** Resolve catalog paths without crossing origins or loading a sealed version. */
    fun assetUrl(path: String): String {
        require(path.isNotBlank() && !path.contains('\\') && path.none { it.isWhitespace() || it.isISOControl() }) {
            "素材地址无效。"
        }
        val supplied = try { URI(path) } catch (_: Exception) {
            throw IllegalArgumentException("素材地址无效。")
        }
        require(supplied.rawUserInfo == null && supplied.rawFragment == null) { "素材地址无效。" }
        val relative = if (supplied.isAbsolute) {
            require(UrlPolicy.sameOrigin(origin, path)) { "素材必须来自当前后台。" }
            supplied.rawPath + (supplied.rawQuery?.let { "?$it" } ?: "")
        } else {
            require(supplied.rawAuthority == null && !path.startsWith("//")) { "素材必须来自当前后台。" }
            "/${path.trimStart('/')}"
        }
        val versioned = if (relative == VERSION_PATH || relative.startsWith("$VERSION_PATH/")) relative
            else "$VERSION_PATH$relative"
        val resolved = URI(origin + versioned)
        val decodedPath = resolved.path
        require(!decodedPath.contains('\\') && decodedPath.none { it.isISOControl() }
            && decodedPath.split('/').none { it == "." || it == ".." }
            && (decodedPath.startsWith("$VERSION_PATH/assets/")
                || decodedPath.startsWith("$VERSION_PATH/api/exhibition/"))) {
            "素材地址不属于当前展台。"
        }
        return resolved.toASCIIString()
    }

    suspend fun connectTerminal(): JSONObject = json(
        "/exhibition/terminals/connect", "POST", JSONObject()
            .put("terminalId", terminalId).put("token", terminalToken)
            .put("label", label).put("platform", "android"),
    )

    suspend fun state(mirrorId: String): JSONObject = json(mirrorPath(mirrorId))

    private var changesSupported = true
    suspend fun changes(mirrorId: String, after: Long): JSONObject {
        if (!changesSupported) return state(mirrorId)
        return try { json("${mirrorPath(mirrorId)}/changes?after=$after", timeoutMs = 10_000) }
        catch (error: ExhibitionApiException) {
            if (error.code != "NOT_FOUND") throw error
            changesSupported = false; state(mirrorId)
        }
    }

    suspend fun liveStatus(mirrorId: String): JSONObject = json("${mirrorPath(mirrorId)}/live/status")

    suspend fun command(
        mirrorId: String,
        action: String,
        revision: Long? = null,
        lookId: String? = null,
    ): JSONObject {
        val body = JSONObject().put("action", action).put("commandId", java.util.UUID.randomUUID().toString())
        // Stop always has priority over a stale selection/start revision.
        if (revision != null && action != "end" && action != "idle") body.put("expectedRevision", revision)
        if (lookId != null) body.put("lookId", lookId)
        return json("${mirrorPath(mirrorId)}/command", "POST", body, 15_000)
    }

    suspend fun createSession(
        mirrorId: String,
        deviceId: String,
        lookId: String,
        generationNumber: Long,
        revision: Long,
    ): JSONObject = json("${mirrorPath(mirrorId)}/live/session", "POST", JSONObject()
        .put("deviceId", deviceId).put("lookId", lookId)
        .put("generationNumber", generationNumber).put("expectedRevision", revision)
        .put("terminalId", terminalId).put("terminalToken", terminalToken), 30_000)

    suspend fun bindReference(
        mirrorId: String,
        sessionId: String,
        deviceId: String,
        lookId: String,
        refImageUrl: String,
    ): JSONObject = json("${mirrorPath(mirrorId)}/live/session/${sessionId(sessionId)}/reference", "POST",
        JSONObject().put("deviceId", deviceId).put("lookId", lookId).put("refImageUrl", refImageUrl), 20_000)

    suspend fun readyReference(mirrorId: String, lookId: String): JSONObject? {
        require(Regex("[A-Za-z0-9_-]{1,100}").matches(lookId)) { "素材编号无效。" }
        return json("${mirrorPath(mirrorId)}/references/$lookId", timeoutMs = 1_500).optJSONObject("reference")
    }

    suspend fun condition(mirrorId: String, sessionId: String, input: JSONObject): JSONObject =
        json("${mirrorPath(mirrorId)}/live/session/${sessionId(sessionId)}/condition", "POST", input, 12_000)

    suspend fun conditionApplied(mirrorId: String, sessionId: String, input: JSONObject): JSONObject =
        json("${mirrorPath(mirrorId)}/live/session/${sessionId(sessionId)}/condition/applied", "POST", input)

    suspend fun link(mirrorId: String, sessionId: String, providerSessionId: String): JSONObject = json(
        "${sessionPath(mirrorId, sessionId)}/link", "POST",
        JSONObject().put("providerSessionId", providerSessionId), 20_000,
    )

    suspend fun firstFrame(mirrorId: String, sessionId: String, elapsedMs: Long): JSONObject = json(
        "${sessionPath(mirrorId, sessionId)}/first-frame", "POST",
        JSONObject().put("firstFrameMs", elapsedMs.coerceIn(0, 120_000)),
    )

    suspend fun heartbeat(mirrorId: String, sessionId: String, deviceId: String): JSONObject = json(
        "${mirrorPath(mirrorId)}/live/heartbeat", "POST",
        JSONObject().put("sessionId", sessionId).put("deviceId", deviceId), 4_000,
    )

    suspend fun prepareRenewal(mirrorId: String, sessionId: String, deviceId: String, sessionNumber: Long, generationNumber: Long): JSONObject = json(
        "${mirrorPath(mirrorId)}/live/session/${sessionId(sessionId)}/renewal", "POST", JSONObject()
            .put("deviceId", deviceId).put("sessionNumber", sessionNumber).put("generationNumber", generationNumber), 8_000)

    suspend fun commitRenewal(mirrorId: String, sessionId: String, deviceId: String, renewalId: String): JSONObject = json(
        "${mirrorPath(mirrorId)}/live/session/${sessionId(sessionId)}/renewal/commit", "POST", JSONObject()
            .put("deviceId", deviceId).put("renewalId", renewalId), 8_000)

    suspend fun stopSession(mirrorId: String, sessionId: String): JSONObject {
        val stopped = json("${sessionPath(mirrorId, sessionId)}/stop", "POST", JSONObject(), 15_000)
        if (stopped.optString("status") != "stopped") {
            throw ExhibitionApiException("STOP_NOT_CONFIRMED", "云端停止尚未确认，请重试停止。")
        }
        return stopped
    }

    suspend fun reportError(
        mirrorId: String,
        deviceId: String,
        sessionId: String?,
        lookId: String,
        sessionNumber: Long,
        generationNumber: Long,
        message: String,
        reason: String? = null,
    ): JSONObject {
        val body = JSONObject().put("deviceId", deviceId).put("lookId", lookId)
            .put("sessionNumber", sessionNumber).put("generationNumber", generationNumber)
            .put("message", safeMessage(message).take(300))
        if (reason != null) body.put("reason", reason)
        if (sessionId != null) body.put("sessionId", sessionId)
        return json("${mirrorPath(mirrorId)}/live/error", "POST", body, 15_000)
    }

    suspend fun image(path: String): ByteArray = request(assetUrl(path), "GET", null, 20_000) { response, active ->
        checkStatus(response, active)
        val mime = response.header("Content-Type").orEmpty().substringBefore(';').trim().lowercase(Locale.ROOT)
        if (mime !in IMAGE_TYPES) throw ExhibitionApiException("INVALID_IMAGE", "素材不是有效图片，请在后台重新上传。")
        val body = response.body() ?: throw ExhibitionApiException("INVALID_IMAGE", "素材图片为空，请重新上传。")
        if (body.contentLength() > MAX_IMAGE_BYTES) throw ExhibitionApiException("IMAGE_TOO_LARGE", "素材图片过大。")
        val result = body.byteStream().use { readLimited(it, MAX_IMAGE_BYTES, active) }
        if (result.isEmpty()) throw ExhibitionApiException("INVALID_IMAGE", "素材图片为空，请在后台重新上传。")
        result
    }

    private fun mirrorPath(id: String): String {
        require(MIRROR_ID.matches(id)) { "智能镜编号无效。" }
        return "/exhibition/mirrors/$id"
    }

    private fun sessionId(id: String): String {
        require(SESSION_ID.matches(id)) { "体验会话编号无效。" }
        return id
    }

    private fun sessionPath(mirrorId: String, id: String) = "${mirrorPath(mirrorId)}/sessions/${sessionId(id)}"

    private suspend fun json(
        path: String,
        method: String = "GET",
        body: JSONObject? = null,
        timeoutMs: Int = 8_000,
    ): JSONObject = request("$origin$VERSION_PATH/api$path", method, body?.toString()?.toByteArray(Charsets.UTF_8), timeoutMs) { response, active ->
        checkStatus(response, active)
        if (!response.header("Content-Type").orEmpty().substringBefore(';').trim().equals("application/json", true)) {
            throw ExhibitionApiException("INVALID_RESPONSE", "后台返回异常，请检查展台网址。")
        }
        val responseBody = response.body() ?: throw ExhibitionApiException("INVALID_RESPONSE", "后台返回为空，请重试。")
        val text = responseBody.byteStream().use { readLimited(it, MAX_JSON_BYTES, active) }.toString(Charsets.UTF_8)
        try { JSONObject(text) } catch (_: Exception) {
            throw ExhibitionApiException("INVALID_RESPONSE", "后台返回异常，请重试。")
        }
    }

    /** No retries or redirects: a repeated allocation could create a second paid credential. */
    private suspend fun <T> request(
        url: String,
        method: String,
        body: ByteArray?,
        timeoutMs: Int,
        read: (Response, () -> Boolean) -> T,
    ): T = withContext(Dispatchers.IO) {
        suspendCancellableCoroutine { continuation ->
            val requestBody = body?.let { RequestBody.create(MediaType.parse("application/json; charset=utf-8"), it) }
            val request = Request.Builder().url(url).method(method, requestBody)
                .header("Accept", "application/json, image/png, image/jpeg, image/webp")
                .header("Cache-Control", "no-store").header("Pragma", "no-cache")
                .header("Origin", origin).header("X-Miror-Protocol", "2").build()
            val call = client.newBuilder()
                .connectTimeout(minOf(timeoutMs, 8_000).toLong(), TimeUnit.MILLISECONDS)
                .readTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
                .writeTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
                .callTimeout(timeoutMs.toLong() + 8_000, TimeUnit.MILLISECONDS)
                .build().newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            try {
                if (!continuation.isActive) return@suspendCancellableCoroutine
                val result = call.execute().use { response -> read(response) { continuation.isActive } }
                if (continuation.isActive) continuation.resume(result)
            } catch (error: Exception) {
                if (continuation.isActive) continuation.resumeWithException(networkError(error))
            }
        }
    }

    private fun checkStatus(response: Response, active: () -> Boolean) {
        val status = response.code()
        if (status in 200..299) return
        if (status in 300..399) throw ExhibitionApiException("BACKEND_REDIRECT", "后台地址已变化，请检查展台网址。", status)
        val text = response.body()?.byteStream()?.use { readLimited(it, MAX_ERROR_BYTES, active) }?.toString(Charsets.UTF_8).orEmpty()
        val payload = try { JSONObject(text) } catch (_: Exception) { null }
        val nested = payload?.optJSONObject("error")
        val rawCode = nested?.optString("code")?.takeIf { it.isNotEmpty() }
            ?: payload?.optString("code")?.takeIf { it.isNotEmpty() }
        val code = rawCode?.takeIf { ERROR_CODE.matches(it) } ?: "REQUEST_FAILED"
        val message = nested?.optString("message")?.takeIf { it.isNotEmpty() }
            ?: payload?.optString("message")?.takeIf { it.isNotEmpty() }
            ?: when (status) {
                403 -> "后台拒绝连接，请检查展台网址与设备绑定。"
                404 -> "未找到智能镜接口，请检查展台网址。"
                else -> "后台暂时不可用，请重试。"
            }
        throw ExhibitionApiException(code, safeMessage(message).take(300), status)
    }

    private fun readLimited(input: InputStream, maximum: Int, active: () -> Boolean): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(16_384)
        while (active()) {
            val count = input.read(buffer)
            if (count == -1) return output.toByteArray()
            if (count > maximum - output.size()) throw ExhibitionApiException("RESPONSE_TOO_LARGE", "后台返回内容过大。")
            output.write(buffer, 0, count)
        }
        throw IOException("cancelled")
    }

    private fun networkError(error: Exception): Exception = when (error) {
        is ExhibitionApiException -> error
        is SSLException -> ExhibitionApiException("TLS_ERROR", "安全连接验证失败，请检查设备证书与日期。")
        is SocketTimeoutException -> ExhibitionApiException("NETWORK_TIMEOUT", "后台连接超时，请重试。")
        is UnknownHostException -> ExhibitionApiException("HOST_UNAVAILABLE", "未找到后台，请检查网络或设置备用 IP。")
        else -> ExhibitionApiException("NETWORK_ERROR", "后台连接中断，请检查网络后重试。")
    }

    private fun safeMessage(message: String): String = message
        .let { if (terminalToken.isNotEmpty()) it.replace(terminalToken, "[凭证已隐藏]") else it }
        .replace(Regex("(?:tk|uk|sk)-[A-Za-z0-9_-]+", RegexOption.IGNORE_CASE), "[凭证已隐藏]")
        .replace(Regex("https?://\\S+", RegexOption.IGNORE_CASE), "[连接地址]")

    private companion object {
        const val VERSION_PATH = "/v1.1"
        const val SCREEN_PATH = "$VERSION_PATH/exhibition/screen"
        const val MAX_IMAGE_BYTES = 64 * 1024 * 1024
        const val MAX_JSON_BYTES = 4 * 1024 * 1024
        const val MAX_ERROR_BYTES = 64 * 1024
        val IMAGE_TYPES = setOf("image/png", "image/jpeg", "image/webp")
        val MIRROR_ID = Regex("[a-z0-9][a-z0-9-]{0,63}")
        val SESSION_ID = Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
        val ERROR_CODE = Regex("[A-Z][A-Z0-9_]{0,79}")
    }
}

class ExhibitionApiException(val code: String, message: String, val status: Int? = null) : IOException(message)
