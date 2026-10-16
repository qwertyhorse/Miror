package ai.openbuy.exhibition

import android.os.SystemClock
import ai.xmax.sdk.CameraPosition
import java.io.IOException
import java.net.URI
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

/** One experience owns one reservation/RTC connection; same-mode choices update its conditions. */
internal class NativeGenerationRound(
    private val api: ExhibitionApi,
    private val mirrorId: String,
    private val deviceId: String,
    state: JSONObject,
    look: JSONObject,
    private val controller: NativeXmaxController,
    private val onStatus: (String) -> Unit,
    private val onError: (String) -> Unit,
    private val onFirstFrame: () -> Unit,
    private val cameraPosition: CameraPosition = CameraPosition.BACK,
    private val cameraDeviceId: String? = null,
    private val cameraRotationDegrees: Int = 0,
    private val cameraCaptureSelection: NativeCameraCaptureSelection = NativeCameraCaptureSelection.Automatic,
    private val xmaxRotationDegrees: Int? = null,
    private val onBusyChanged: () -> Unit = {},
) {
    private var snapshot = JSONObject(state.toString())
    private var selection = JSONObject(look.toString())
    private val sessionNumber = snapshot.optLong("sessionNumber", -1)
    private val generationNumber get() = snapshot.optLong("generationNumber", -1)
    private val revision = snapshot.optLong("revision", -1)
    private val lookId get() = selection.optString("id")
    private val mode = selection.optString("mode", "clothx")
    private fun selectionKey(state: JSONObject, look: JSONObject) = "$mirrorId:$sessionNumber:${state.optLong("generationNumber")}:${look.optString("id")}:$mode"
    var key: String = selectionKey(snapshot, selection)
        private set
    private val updates = Channel<Pair<JSONObject, JSONObject>>(Channel.CONFLATED)
    var cleanupConfirmed = true
        private set
    private var connected = false
    private var retryable = false
    private var renewing = false
    private var renewalStopping = false
    private var acknowledgedKey: String? = null
    private var conditionBusy = false
    var isBusy = true
        private set(value) {
            if (field == value) return
            field = value
            onBusyChanged()
        }
    private var stopReason = "provider_rejected"
    private var leaseDeadline = 0L
    private var referencePreparation: Deferred<String?>? = null

    fun canReuse(state: JSONObject, look: JSONObject): Boolean = connected && !renewalStopping && mode != "mox"
        && state.optString("providerMode") == "xmax" && state.optString("phase") in listOf("generating", "showcase")
        && state.optLong("sessionNumber", -1) == sessionNumber && state.optString("experienceMode") == mode
        && look.optString("mode", "clothx") == mode
        && state.optJSONObject("live")?.let { it.optString("sessionId") == localSessionId && it.optString("deviceId") == deviceId } == true

    fun update(state: JSONObject, look: JSONObject) {
        if (!canReuse(state, look)) return
        val nextKey = selectionKey(state, look)
        if (key == nextKey) return
        key = nextKey
        isBusy = true
        retryable = false
        referencePreparation?.cancel()
        updates.trySend(JSONObject(state.toString()) to JSONObject(look.toString()))
    }

    fun retryUpdate(): Boolean {
        if (!connected || !retryable) return false
        isBusy = true
        retryable = false
        updates.trySend(JSONObject(snapshot.toString()) to JSONObject(selection.toString()))
        return true
    }

    private var localSessionId: String? = null
    private var providerRegion: String? = null
    private var allocationStarted = false
    private var hasRun = false
    private val remoteFirstFrame = CompletableDeferred<Unit>()
    private val controllerFailure = CompletableDeferred<String>()

    /** Cancellation returns only after camera/RTC and the backend reservation are settled. */
    suspend fun run(): Nothing {
        check(!hasRun) { "本轮体验已经启动。" }
        hasRun = true
        val experienceStartedAt = SystemClock.elapsedRealtime()
        try {
            coroutineScope {
                NativeRoundMetadata.requireValid(snapshot.optJSONObject("publication") != null, "请更新后台并发布素材后开始体验。")
                NativeRoundMetadata.validateSnapshot(snapshot, selection, mirrorId, deviceId)
                val noReference = selection.optString("referenceKind", "image") == "none"
                val referenceImage = NativeRoundMetadata.referenceImage(selection)
                val prompt = NativeRoundMetadata.prompt(selection)
                status("准备素材")
                // A bad or missing local asset must fail before requesting a paid credential.
                val prepared = if (noReference) null else preparedReference(selection)
                if (!noReference) requirePrepared(prepared)
                // MoX still needs the local photo as its video source, never as an SDK upload.
                val image = if (mode == "mox") api.image(referenceImage!!).also(NativeRoundMetadata::imageMime) else null

                status("连接中")
                allocationStarted = true
                val allocationSentAt = SystemClock.elapsedRealtime()
                val created = api.createSession(mirrorId, deviceId, lookId, generationNumber, revision)
                // Retain ownership immediately, including when subsequent metadata is invalid.
                created.optString("id").takeIf(NativeRoundMetadata.sessionId::matches)?.let {
                    localSessionId = it
                }
                val id = localSessionId ?: throw NativeRoundException("后台会话编号无效。")
                leaseDeadline = allocationSentAt + 18_000
                launch {
                    while (true) {
                        delay((leaseDeadline - SystemClock.elapsedRealtime()).coerceAtLeast(1))
                        if (SystemClock.elapsedRealtime() >= leaseDeadline) {
                            stopReason = "lease_expired"
                            throw NativeRoundException("后台连接中断，正在恢复。")
                        }
                    }
                }
                val prebound = !noReference && NativeRoundMetadata.integer(created, "referenceVersion") == 1L
                val createdReference = if (prebound) created.optString("refImageUrl") else ""
                if (prebound) NativeRoundMetadata.requireValid(NativeRoundMetadata.isRemoteImage(createdReference), "后台参考图无效。")
                val expiresAt = validateRecord(created, noReference, prompt, if (prebound) 1 else 0, createdReference, null)
                val token = created.optString("token")
                NativeRoundMetadata.requireValid(NativeRoundMetadata.temporaryKey.matches(token), "临时连接凭证无效。")
                NativeRoundMetadata.requireValid(created.optString("model") == "x2.0", "当前模型不支持展台体验。")
                val region = created.getString("providerRegion")
                providerRegion = region
                val continuous = created.optJSONObject("exhibition")?.optBoolean("continuous", false) == true && mode != "mox"
                launch {
                    var failures = 0
                    while (true) {
                        val sentAt = SystemClock.elapsedRealtime()
                        try {
                            val reply = api.heartbeat(mirrorId, id, deviceId)
                            leaseDeadline = sentAt + 18_000
                            failures = 0
                            val live = reply.optJSONObject("live")
                            if (live == null || live.optString("sessionId") != id || live.optString("deviceId") != deviceId) {
                                stopReason = "lease_expired"; throw NativeRoundException("设备占用已结束。")
                            }
                            if (continuous && connected && !conditionBusy && !renewing &&
                                (live.optBoolean("renewalDue", false) || expiresAt - System.currentTimeMillis() <= 15_000)) {
                                renewing = true
                                isBusy = true
                                val renewalKey = key
                                val renewalGeneration = generationNumber
                                launch {
                                    var keepConnection = false
                                    try {
                                        val plan = try {
                                            api.prepareRenewal(mirrorId, id, deviceId, sessionNumber, renewalGeneration)
                                        } catch (cancelled: CancellationException) { throw cancelled }
                                        catch (error: ExhibitionApiException) {
                                            // Preparation has not stopped anything. Retry on a later heartbeat;
                                            // ownership and expiry watchdogs still fence the existing connection.
                                            if (error.status == 429 || (error.status ?: 0) >= 500 || error.code in setOf(
                                                    "NETWORK_ERROR", "NETWORK_TIMEOUT", "HOST_UNAVAILABLE",
                                                    "EXHIBITION_STALE_GENERATION", "EXHIBITION_OWNER_MISMATCH", "EXHIBITION_RENEWAL_UNAVAILABLE")) {
                                                keepConnection = true
                                                return@launch
                                            }
                                            throw error
                                        }
                                        if (key != renewalKey || conditionBusy) { keepConnection = true; return@launch }
                                        val renewalId = plan.optString("renewalId")
                                        if (renewalId.isBlank()) throw NativeRoundException("续接计划无效。")
                                        renewalStopping = true
                                        status("恢复连接")
                                        connected = false
                                        controller.disconnect()
                                        confirmedStop(id)
                                        api.commitRenewal(mirrorId, id, deviceId, renewalId)
                                        stopReason = "renewal_completed"
                                        throw NativeRoundException("连接已续接。")
                                    } finally {
                                        if (keepConnection) {
                                            renewing = false
                                            isBusy = conditionBusy || retryable || acknowledgedKey != key
                                        }
                                    }
                                }
                            }
                        } catch (cancelled: CancellationException) { throw cancelled }
                        catch (failure: Exception) {
                            if (failure is NativeRoundException || (failure is ExhibitionApiException && failure.code == "EXHIBITION_OWNER_MISMATCH")) {
                                stopReason = "lease_expired"; throw failure
                            }
                            failures++
                            if (SystemClock.elapsedRealtime() >= leaseDeadline) { stopReason = "lease_expired"; throw failure }
                        }
                        delay(if (failures == 0) 3_000 else (1_000L shl (failures - 1).coerceAtMost(2)))
                    }
                }
                launch {
                    delay((expiresAt - System.currentTimeMillis()).coerceAtLeast(0))
                    stopReason = "credential_expired"
                    throw NativeRoundException("正在恢复连接。")
                }
                withContext(Dispatchers.Main.immediate) {
                    controller.onFirstFrame = { remoteFirstFrame.complete(Unit) }
                    controller.onError = { controllerFailure.complete(NativeRoundMetadata.safeMessage(it)) }
                }
                launch { val message = controllerFailure.await(); stopReason = "rtc_failed"; throw NativeRoundException(message) }

                val scope = created.optString("referenceScope")
                val reference = if (!noReference) {
                    val binding = requirePrepared(prepared, scope)
                    val bound = if (prebound) created else api.bindReference(mirrorId, id, deviceId, lookId, binding)
                    val url = bound.optString("refImageUrl")
                    NativeRoundMetadata.requireValid(NativeRoundMetadata.isRemoteImage(url), "后台参考图无效。")
                    validateRecord(bound, false, prompt, 1, url, null)
                    url
                } else null

                val providerId = controller.connect(
                    token = token,
                    region = region,
                    model = "x2.0",
                    position = cameraPosition,
                    image = if (mode == "mox") image else null,
                    cameraDeviceId = if (mode == "mox") null else cameraDeviceId,
                    cameraRotationDegrees = if (mode == "mox") 0 else cameraRotationDegrees,
                    captureSelection = if (mode == "mox") NativeCameraCaptureSelection.Automatic else cameraCaptureSelection,
                    xmaxRotationDegrees = if (mode == "mox") null else xmaxRotationDegrees,
                )
                NativeRoundMetadata.requireValid(NativeRoundMetadata.providerSessionId.matches(providerId), "实时会话编号无效。")
                val linked = api.link(mirrorId, id, providerId)
                validateRecord(linked, noReference, prompt, if (noReference) 0 else 1, reference.orEmpty(), providerId)

                val firstReceipt = CompletableDeferred<Unit>()
                launch {
                    if (withTimeoutOrNull(45_000) { remoteFirstFrame.await() } == null) {
                        stopReason = "rtc_failed"
                        throw NativeRoundException("生成画面超时，正在恢复。")
                    }
                    val receipt = api.firstFrame(mirrorId, id, SystemClock.elapsedRealtime() - experienceStartedAt)
                    validateRecord(receipt, noReference, prompt, if (noReference) 0 else 1, reference.orEmpty(), providerId)
                    NativeRoundMetadata.requireValid((NativeRoundMetadata.integer(receipt, "firstFrameMs") ?: -1)
                        in 0L..120_000L, "首帧确认失败，请重试。")
                    withContext(Dispatchers.Main.immediate) { onFirstFrame() }
                    firstReceipt.complete(Unit)
                }
                status("正在生成")
                controller.generate(prompt, reference)
                firstReceipt.await()
                connected = true
                acknowledgedKey = key
                isBusy = false
                var version = if (noReference) 0L else 1L
                var boundGeneration = generationNumber
                for ((next, nextLook) in updates) {
                    if (renewalStopping) continue
                    conditionBusy = true
                    var dispatched = false
                    var acknowledged = false
                    snapshot = next; selection = nextLook
                    val operationKey = selectionKey(next, nextLook)
                    try {
                        NativeRoundMetadata.validateSnapshot(snapshot, selection, mirrorId, deviceId)
                        val none = selection.optString("referenceKind", "image") == "none"
                        val nextPrompt = NativeRoundMetadata.prompt(selection)
                        status("准备素材")
                        val referenceValue = supervisorScope {
                            // Only independent image preparation is cancelled by a newer choice.
                            // Backend binding and SDK condition updates remain serialized.
                            val preparing = async {
                                if (none) null else requirePrepared(preparedReference(selection), scope)
                            }
                            referencePreparation = preparing
                            try { preparing.await() } finally { referencePreparation = null }
                        }
                        if (operationKey != key) continue
                        val intent = JSONObject().put("deviceId", deviceId).put("lookId", lookId)
                            .put("sessionNumber", sessionNumber).put("generationNumber", generationNumber)
                        if (referenceValue != null) intent.put("bindingId", referenceValue)
                        val bound = api.condition(mirrorId, id, intent)
                        val url = if (none) null else bound.optString("refImageUrl").also {
                            NativeRoundMetadata.requireValid(NativeRoundMetadata.isRemoteImage(it), "后台参考图无效。")
                        }
                        val nextVersion = NativeRoundMetadata.integer(bound, "referenceVersion") ?: -1
                        NativeRoundMetadata.requireValid(nextVersion > version || (nextVersion == version && boundGeneration == generationNumber), "素材版本未更新。")
                        validateRecord(bound, none, nextPrompt, nextVersion, url.orEmpty(), providerId)
                        version = nextVersion
                        boundGeneration = generationNumber
                        if (operationKey != key) continue
                        status("正在生成")
                        dispatched = true
                        if (withTimeoutOrNull(15_000) { controller.generate(nextPrompt, url); true } != true) {
                            stopReason = "command_unknown"; throw NativeRoundException("换装结果未确认，正在恢复连接。")
                        }
                        if (operationKey != key) continue
                        api.conditionApplied(mirrorId, id, intent.put("referenceVersion", version))
                        acknowledged = true
                        acknowledgedKey = operationKey
                        if (operationKey == key) status("实时生成")
                    } catch (cancelled: CancellationException) {
                        currentCoroutineContext().ensureActive()
                        if (operationKey == key) throw cancelled
                    }
                    catch (error: Exception) {
                        if (dispatched) { stopReason = "command_unknown"; throw error }
                        if (operationKey == key) withContext(Dispatchers.Main.immediate) {
                            retryable = true
                            onError(NativeRoundMetadata.safeMessage(error.message.orEmpty()))
                        }
                    } finally {
                        conditionBusy = false
                        // A newer manual choice remains pending in the conflated channel.
                        // Only its server acknowledgement can reopen gesture input.
                        if (operationKey == key && acknowledged && !retryable && !renewing) isBusy = false
                    }
                }
                throw CancellationException("Experience stopped")
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Throwable) {
            if (stopReason == "renewal_completed") throw failure
            val message = NativeRoundMetadata.safeMessage(failure.message.orEmpty())
            withContext(Dispatchers.Main.immediate) { onError(message) }
            try {
                api.reportError(mirrorId, deviceId, localSessionId, lookId, sessionNumber, generationNumber, message, stopReason)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // Cleanup below independently requires confirmation of the actual stop.
            }
            throw failure
        } finally {
            isBusy = true
            connected = false
            updates.close()
            withContext(NonCancellable) {
                withContext(Dispatchers.Main.immediate) {
                    controller.onFirstFrame = null
                    controller.onError = null
                }
                coroutineScope {
                    val native = async { runCatching { controller.disconnect() } }
                    val backend = async { runCatching { stopOwnedReservation() } }
                    val nativeFailure = native.await().exceptionOrNull()
                    val backendFailure = backend.await().exceptionOrNull()
                    cleanupConfirmed = nativeFailure == null && backendFailure == null
                    if (backendFailure != null) {
                        withContext(Dispatchers.Main.immediate) { onError("云端停止尚未确认，请重试停止。") }
                    } else if (nativeFailure != null) {
                        withContext(Dispatchers.Main.immediate) { onError("摄像头释放失败，请重新打开应用。") }
                    }
                }
            }
        }
    }

    private suspend fun preparedReference(look: JSONObject): JSONObject? = try {
        api.readyReference(mirrorId, look.getString("id"))?.takeIf {
            NativeRoundMetadata.isRemoteImage(it.optString("url")) && it.optString("scope").isNotEmpty()
                && it.optLong("freshUntil") > System.currentTimeMillis()
        }
    } catch (cancelled: CancellationException) { throw cancelled }
    catch (_: Exception) { null } // Published catalogs reject unavailable bindings before allocating a credential.

    private fun requirePrepared(value: JSONObject?, expectedScope: String? = null): String {
        NativeRoundMetadata.requireValid(value != null && value.optString("bindingId").isNotBlank()
            && value.optLong("freshUntil") > System.currentTimeMillis()
            && (expectedScope == null || (expectedScope.isNotBlank() && value.optString("scope") == expectedScope)),
            "这件素材暂不可用，请在后台检查。")
        return value!!.getString("bindingId")
    }

    private suspend fun status(value: String) = withContext(Dispatchers.Main.immediate) { onStatus(value) }

    private fun validateRecord(
        record: JSONObject,
        noReference: Boolean,
        prompt: String,
        referenceVersion: Long,
        referenceUrl: String,
        providerId: String?,
    ): Long {
        val meta = record.optJSONObject("exhibition")
        NativeRoundMetadata.requireValid(record.optString("id") == localSessionId
            && record.optString("status") == "active"
            && record.optString("sourceKind") == if (mode == "mox") "photo" else "camera", "后台会话与输入类型不一致。")
        NativeRoundMetadata.requireValid(meta != null
            && meta.optString("mirrorId") == mirrorId
            && meta.optString("deviceId") == deviceId
            && meta.optString("lookId") == lookId
            && NativeRoundMetadata.integer(meta, "sessionNumber") == sessionNumber
            && NativeRoundMetadata.integer(meta, "generationNumber") == generationNumber
            && meta.optString("mode") == mode
            && meta.optString("prompt") == prompt, "后台会话与本轮素材不一致。")
        val asset = record.optString("referenceAsset")
        NativeRoundMetadata.requireValid(if (noReference) asset.isEmpty() else
            asset.isNotBlank() && api.assetUrl(asset) == api.assetUrl(NativeRoundMetadata.referenceImage(selection).orEmpty()), "后台参考素材不一致。")
        NativeRoundMetadata.requireValid(NativeRoundMetadata.integer(record, "referenceVersion") == referenceVersion
            && record.optString("refImageUrl") == referenceUrl
            && record.optString("providerSessionId") == providerId.orEmpty(), "后台会话关联未确认。")
        val region = record.optString("providerRegion")
        NativeRoundMetadata.requireValid(region in setOf("cn", "global")
            && (providerRegion == null || providerRegion == region), "服务区域无效。")
        return NativeRoundMetadata.expiryMillis(record)
    }

    private suspend fun stopOwnedReservation() {
        localSessionId?.let { confirmedStop(it); return }
        if (!allocationStarted) return
        // A cancelled/lost create reply can still have reserved a credential server-side.
        // Re-read briefly; never stop a replacement generation or a different terminal.
        var pendingOwnedReservation = false
        repeat(3) { attempt ->
            val current = api.state(mirrorId)
            val live = current.optJSONObject("live")
            if (NativeRoundMetadata.ownedLive(current, live, deviceId, lookId, sessionNumber, generationNumber)) {
                pendingOwnedReservation = true
                val id = live!!.optString("sessionId")
                if (NativeRoundMetadata.sessionId.matches(id)) {
                    localSessionId = id
                    confirmedStop(id)
                    return
                }
            } else if (live != null || NativeRoundMetadata.integer(current, "sessionNumber") != sessionNumber
                || NativeRoundMetadata.integer(current, "generationNumber") != generationNumber) return
            if (attempt < 2) delay(250)
        }
        if (pendingOwnedReservation) throw NativeRoundException("云端停止尚未确认，请重试停止。")
    }

    private suspend fun confirmedStop(id: String) {
        val stopped = api.stopSession(mirrorId, id)
        NativeRoundMetadata.requireValid(stopped.optString("id") == id
            && stopped.optString("status") == "stopped", "云端停止尚未确认，请重试停止。")
    }
}

/** Pure metadata rules shared by all stages; contains no provider or network calls. */
internal object NativeRoundMetadata {
    val sessionId = Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
    val providerSessionId = Regex("ums-[A-Za-z0-9_-]+")
    val temporaryKey = Regex("tk-[A-Za-z0-9_-]{1,1024}")
    private val fixedPrompts = mapOf(
        "charx" to "视频中角色替换成参考图中角色",
        "clothx" to "视频中人物衣服替换成参考图中衣服",
        "vibex" to "视频风格变为参考图指定的风格",
        "dimx" to "指定角色在场景中互动",
        "mox" to "视频中角色跟随拖拽轨迹运动",
    )

    fun requireValid(condition: Boolean, message: String) {
        if (!condition) throw NativeRoundException(message)
    }

    fun expiryMillis(record: JSONObject, nowMillis: Long = System.currentTimeMillis()): Long {
        // Android 9/10's Instant.parse only accepts Z, while XMAX returns +00:00.
        // Parse an explicit offset without guessing the device timezone or extending expiry.
        val expiresAt = try {
            OffsetDateTime.parse(record.getString("expiresAt"), DateTimeFormatter.ISO_OFFSET_DATE_TIME)
                .toInstant().toEpochMilli()
        } catch (_: Exception) { throw NativeRoundException("体验有效期无效。") }
        requireValid(expiresAt > nowMillis, "本次体验已过期，请重试。")
        return expiresAt
    }

    fun integer(value: JSONObject, field: String): Long? {
        val number = value.opt(field) as? Number ?: return null
        val decimal = number.toDouble()
        if (!decimal.isFinite() || decimal < 0 || decimal > 9_007_199_254_740_991.0
            || decimal != number.toLong().toDouble()) return null
        return number.toLong()
    }

    fun referenceImage(look: JSONObject): String? = if (look.optString("referenceKind", "image") == "none") null
        else look.optString("referenceImage", look.optString("image"))

    fun validateSnapshot(state: JSONObject, look: JSONObject, mirrorId: String, deviceId: String) {
        val mode = look.optString("mode", "clothx")
        requireValid(Regex("[a-z0-9][a-z0-9-]{0,63}").matches(mirrorId)
            && Regex("[A-Za-z0-9_-]{8,100}").matches(deviceId), "设备编号无效。")
        requireValid(state.optString("providerMode") == "xmax" && state.optString("phase") == "generating"
            && state.optString("experienceMode") == mode && state.optString("selectedLookId") == look.optString("id")
            && look.optString("id").isNotBlank()
            && (integer(state, "sessionNumber") ?: 0) > 0
            && (integer(state, "generationNumber") ?: 0) > 0
            && integer(state, "revision") != null, "本轮体验已更新，请重新开始。")
        val kind = look.optString("referenceKind", "image")
        requireValid(kind == "image" || (kind == "none" && mode == "free"), "此模式需要参考图。")
        requireValid(kind == "none" || !referenceImage(look).isNullOrBlank(), "请先在后台上传参考图。")
        prompt(look)
    }

    fun prompt(look: JSONObject): String {
        val mode = look.optString("mode", "clothx")
        fixedPrompts[mode]?.let { return it }
        requireValid(mode == "free", "体验模式无效。")
        val raw = look.optString("prompt")
        val trimmed = raw.trim()
        requireValid(trimmed.isNotEmpty() && trimmed.length <= 1_000
            && !Regex("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]").containsMatchIn(raw), "请在后台填写有效提示词。")
        return trimmed
    }

    fun imageMime(bytes: ByteArray): String {
        fun at(index: Int) = bytes[index].toInt() and 255
        if (bytes.size >= 8 && at(0) == 137 && bytes.copyOfRange(1, 8).contentEquals(byteArrayOf(80, 78, 71, 13, 10, 26, 10))) return "image/png"
        if (bytes.size >= 3 && at(0) == 255 && at(1) == 216 && at(2) == 255) return "image/jpeg"
        if (bytes.size >= 12 && String(bytes, 0, 4, Charsets.US_ASCII) == "RIFF"
            && String(bytes, 8, 4, Charsets.US_ASCII) == "WEBP") return "image/webp"
        throw NativeRoundException("参考图格式不支持，请重新上传。")
    }

    fun isRemoteImage(value: String): Boolean = try {
        val uri = URI(value)
        uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.rawUserInfo == null && uri.rawFragment == null
    } catch (_: Exception) { false }

    fun ownedLive(state: JSONObject, live: JSONObject?, deviceId: String, lookId: String,
                  sessionNumber: Long, generationNumber: Long): Boolean = live != null
        && live.optString("deviceId") == deviceId && live.optString("lookId") == lookId
        && integer(live, "generationNumber") == generationNumber
        && integer(state, "sessionNumber") == sessionNumber && integer(state, "generationNumber") == generationNumber

    fun safeMessage(value: String): String = value
        .replace(Regex("(?:tk|uk|sk)-[A-Za-z0-9_-]+", RegexOption.IGNORE_CASE), "[凭证已隐藏]")
        .replace(Regex("https?://\\S+", RegexOption.IGNORE_CASE), "[连接地址]")
        .replace(Regex("[\\p{Cntrl}&&[^\\n\\t]]"), "")
        .trim().take(300).ifBlank { "实时体验中断，请重试。" }
}

private class NativeRoundException(message: String) : IOException(message)
