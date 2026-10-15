package ai.openbuy.exhibition

import android.Manifest
import android.app.Activity
import android.app.Dialog
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Build
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.*
import ai.xmax.sdk.CameraPosition
import ai.xmax.sdk.VideoContentMode
import ai.xmax.sdk.XmaxRealtimeVideoView
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import org.json.JSONObject
import java.util.UUID
import kotlin.math.max

/** Native exhibition terminal; the LAN backend remains the owner of catalog and quotas. */
class NativeExhibitionActivity : Activity() {
    private val cleanupScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var work: Job? = null
    private var shutdown: Job? = null
    private var started = false
    private var destroyed = false
    private var restartEpoch = 0L
    private lateinit var prefs: SharedPreferences
    private lateinit var api: ExhibitionApi
    private lateinit var controller: NativeXmaxController
    private lateinit var video: XmaxRealtimeVideoView
    private lateinit var status: TextView
    private lateinit var kiosk: MirrorKioskView
    private lateinit var pairing: LinearLayout
    private lateinit var pairTitle: TextView
    private lateinit var pairCode: TextView
    private lateinit var demoImage: ImageView
    private lateinit var skin: ImageView
    private lateinit var primary: Button
    private lateinit var terminalId: String
    private lateinit var terminalToken: String
    private lateinit var screenUrl: String
    private val deviceId = "native-${UUID.randomUUID()}"
    private var mirrorId: String? = null
    private var mirrorName = "展会试衣镜"
    private var state: JSONObject? = null
    private var provider: JSONObject? = null
    private var bindingCode = ""
    private var healthy = false
    private var cameraReady = false
    private var previewFailed = false
    private var permissionAsked = false
    private var position = CameraPosition.BACK
    private var cameraDeviceId: String? = null
    private var activeCameraDeviceId: String? = null
    private var cameraSettingsOpen = false
    private var settingsDialog: Dialog? = null
    private var lastUiMode = ""
    private var cameraSettingsPanel: NativeCameraSettingsPanel? = null
    private var cameraSettingsCleanup: Job? = null
    private lateinit var remoteCamera: NativeCameraRemote
    private var remoteCameraRequest: NativeCameraOpenRequest? = null
    private var remoteCameraExpiry: Job? = null
    private var cameraSnapshot: NativeCameraSnapshot? = null
    private var error = ""
    private var backendError = ""
    private var generationStatus = ""
    private var actionBusy = false
    private var stopBusy = false
    private var actionName = ""
    private var actionEpoch = 0L
    private var actionJob: Job? = null
    private var round: NativeGenerationRound? = null
    private var roundJob: Job? = null
    private val attempted = mutableSetOf<String>()
    private val stoppedGeneration = mutableMapOf<String, Long>()
    private val imageCache = object : android.util.LruCache<String, Bitmap>(12 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = max(1, value.allocationByteCount / 1024)
    }
    private val imageScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val imageSlots = Semaphore(2)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        prefs = getSharedPreferences("exhibition-device", MODE_PRIVATE)
        val savedScreenUrl = prefs.getString("screen-url", null)
        val migratedPreferences = prefs.edit()
        if (UrlPolicy.shouldClearLegacyFallback(savedScreenUrl, prefs.getString("backend-ip", ""),
                prefs.getBoolean("backend-ip-prefilled", false))) migratedPreferences.remove("backend-ip")
        terminalId = prefs.getString("terminal-id", null) ?: "terminal-${UUID.randomUUID()}"
        terminalToken = prefs.getString("terminal-token", null) ?: "${UUID.randomUUID()}${UUID.randomUUID()}"
        check(prefs.edit().putString("terminal-id", terminalId).putString("terminal-token", terminalToken).commit())
        screenUrl = runCatching {
            val saved = UrlPolicy.migrateDefaultScreenUrl(savedScreenUrl)
            ExhibitionApi(saved, terminalId, terminalToken, Build.MODEL)
            saved
        }
            .getOrDefault(UrlPolicy.DEFAULT_URL)
        check(migratedPreferences.putString("screen-url", screenUrl).commit())
        position = if (prefs.getString("native-camera", "back") == "front") CameraPosition.FRONT else CameraPosition.BACK
        cameraDeviceId = prefs.getString("native-camera-id", null)?.takeIf { it.isNotEmpty() }
        remoteCamera = NativeCameraRemote(prefs.getStringSet("native-camera-handled-requests", emptySet()).orEmpty())
        api = newApi()
        buildInterface()
        controller = NativeXmaxController(this, video)
        controller.onCameraSnapshot = { snapshot ->
            cameraSnapshot = snapshot
            if (!cameraSettingsOpen) reportCamera("ready")
        }
        render()
    }

    private fun newApi() = ExhibitionApi(screenUrl, terminalId, terminalToken,
        "${Build.MANUFACTURER} ${Build.MODEL}".take(80), LanBackendDns(applicationContext, screenUrl, prefs.getString("backend-ip", "")))

    override fun onStart() {
        super.onStart()
        started = true
        restartWork()
        if (!hasCameraPermission() && !permissionAsked) {
            permissionAsked = true
            requestPermissions(arrayOf(Manifest.permission.CAMERA), 41)
        }
    }

    override fun onResume() {
        super.onResume()
        MirrorImmersive.apply(window)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) MirrorImmersive.apply(window)
    }

    override fun onStop() {
        started = false
        settingsDialog?.dismiss()
        restartWork()
        super.onStop()
    }

    override fun onDestroy() {
        destroyed = true
        restartEpoch++
        imageScope.cancel()
        imageCache.evictAll()
        settingsDialog?.dismiss()
        cleanupScope.launch { shutdown?.join(); cameraSettingsCleanup?.join(); cleanupScope.cancel() }
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 41) {
            previewFailed = false
            error = if (hasCameraPermission()) "" else "请允许摄像头权限"
            if (hasCameraPermission()) cameraSettingsPanel?.rescan()
            render()
        }
    }

    /** One engine owns all SDK operations. A replacement waits for its predecessor's cleanup. */
    private fun restartWork() {
        val requestedEpoch = ++restartEpoch
        val old = work
        work = null
        old?.cancel()
        val preceding = shutdown
        val precedingCameraCleanup = cameraSettingsCleanup
        shutdown = cleanupScope.launch {
            preceding?.join()
            old?.join()
            precedingCameraCleanup?.join()
            if (requestedEpoch == restartEpoch && started && !destroyed) {
                work = cleanupScope.launch {
                    try {
                        supervisorScope {
                            val poller = launch { pollBackend() }
                            try {
                                if (cameraSettingsOpen) awaitCancellation() else runEngine()
                            } finally { poller.cancelAndJoin() }
                        }
                    } catch (cancel: CancellationException) { throw cancel }
                    catch (_: Exception) { error = "设备连接中断，点状态重试"; render() }
                }
            }
        }
    }

    private suspend fun pollBackend() {
        var lastBinding = 0L
        var lastProvider = 0L
        var pendingCameraRequest: JSONObject? = null
        while (currentCoroutineContext().isActive) {
            val owner = api
            try {
                val now = android.os.SystemClock.elapsedRealtime()
                if (now - lastBinding >= 3_000 || mirrorId == null) {
                    val cameraReport = remoteCamera.report(System.currentTimeMillis())
                    val binding = owner.connectTerminal(cameraReport)
                    if (owner !== api) continue
                    if (binding.optBoolean("cameraReportAccepted")) remoteCamera.acknowledge(cameraReport)
                    if (!cameraSettingsOpen && binding.optBoolean("cameraReportAccepted") &&
                        cameraReport?.optString("status") == "closed" &&
                        (cameraReport.optString("requestId") == remoteCameraRequest?.id ||
                            remoteCameraRequest?.expiresAt?.let { it <= System.currentTimeMillis() } == true)) {
                        remoteCameraRequest = null
                        reportCamera(if (previewFailed) "error" else if (!hasCameraPermission()) "permission-required" else "ready",
                            if (previewFailed) "摄像头不可用，请重新检测" else null)
                    }
                    val incoming = binding.string("mirrorId").ifBlank { null }
                    if (remoteCamera.bind(incoming, binding.string("cameraBindingId"))) {
                        cameraSnapshot = null
                        remoteCameraRequest?.let { if (!remoteCamera.owns(it)) settingsDialog?.dismiss() }
                        remoteCameraRequest = null
                        reportCamera(if (hasCameraPermission()) "ready" else "permission-required")
                    }
                    if (incoming != mirrorId) {
                        mirrorId = incoming
                        state = null
                        provider = null
                        lastProvider = 0
                    }
                    mirrorName = binding.string("mirrorName").ifBlank { "展会试衣镜" }
                    bindingCode = binding.string("code")
                    pendingCameraRequest = binding.optJSONObject("cameraRequest")
                    lastBinding = now
                }
                val id = mirrorId
                if (id != null) {
                    val fresh = state?.let { owner.changes(id, it.optLong("revision", 0)) } ?: owner.state(id)
                    if (owner !== api || id != mirrorId) continue
                    if (!stopBusy) adoptState(fresh)
                    if (cameraSettingsOpen && cameraIsLocked()) settingsDialog?.dismiss()
                    if (now - lastProvider >= 10_000) {
                        provider = owner.liveStatus(id)
                        lastProvider = now
                    }
                    pendingCameraRequest?.let { handleRemoteCameraRequest(it) }
                    pendingCameraRequest = null
                }
                if (!healthy && error == backendError) error = ""
                backendError = ""
                healthy = true
                render()
                delay(if (id == null) 10_000 else 100)
            } catch (cancel: CancellationException) { throw cancel }
            catch (cause: Exception) {
                if (owner === api) {
                    healthy = false
                    if (cameraSettingsOpen && remoteCameraRequest != null) settingsDialog?.dismiss()
                    backendError = userError(cause, "后台连接中断，请检查网络")
                    error = backendError
                    render()
                }
                delay(2_000)
            }
        }
    }

    private suspend fun runEngine() = coroutineScope {
        var runningApi: ExhibitionApi? = null
        var runningMirror: String? = null
        var currentPosition = position
        var currentDeviceId = cameraDeviceId
        try {
            while (isActive) {
                if (attempted.size > 128) attempted.remove(attempted.first())
                val latest = state
                val id = mirrorId
                val activeKey = if (id != null && latest != null) generationKey(id, latest) else null
                val currentSelection = selectedLook(latest)
                val reusable = latest != null && currentSelection != null && round?.canReuse(latest, currentSelection) == true
                val valid = latest?.string("providerMode") == "xmax" &&
                    latest.string("phase") in listOf("generating", "showcase") &&
                    runningApi === api && runningMirror == id && (round?.key == activeKey || reusable) && currentPosition == position && currentDeviceId == cameraDeviceId
                if (roundJob != null && (!valid || roundJob?.isCompleted == true)) {
                    roundJob?.cancelAndJoin()
                    if (round?.cleanupConfirmed == false) { previewFailed = true; error = "停止状态未确认，请重试停止。" }
                    roundJob = null
                    round = null
                    cameraReady = false
                    generationStatus = ""
                    render()
                    continue // Cleanup can advance the backend revision and replace the selection.
                }
                if (valid && reusable && round?.key != activeKey) {
                    activeKey?.let(attempted::add)
                    round?.update(latest, currentSelection)
                }
                val look = currentSelection
                val live = latest?.optJSONObject("live")
                val needsCamera = latest?.string("experienceMode") != "mox"
                if (roundJob == null && !needsCamera && cameraReady) {
                    controller.disconnect()
                    cameraReady = false
                    render()
                }
                val canConnect = healthy && !previewFailed && id != null && latest != null && look != null &&
                    latest.string("phase") == "generating" && latest.string("providerMode") == "xmax" &&
                    (latest.optJSONObject("lifecycle")?.optLong("retryAt", 0) ?: 0) <= System.currentTimeMillis() &&
                    activeKey !in attempted && latest.optLong("generationNumber") > (stoppedGeneration[id] ?: -1) &&
                    !stopBusy && !cameraSettingsOpen && !controller.hasReleaseFailure && live == null && (!needsCamera || cameraReady)
                if (roundJob == null && canConnect && id != null) provider = api.liveStatus(id)
                if (roundJob == null && !cameraSettingsOpen && !stopBusy && provider?.string("providerId") == "decart") {
                    controller.disconnect()
                    cameraReady = false
                    if (controller.hasReleaseFailure) { error = "摄像头释放未确认，请重试。"; render(); delay(1000); continue }
                    prefs.edit().putString("screen-url", screenUrl).apply()
                    startActivity(Intent(this@NativeExhibitionActivity, MainActivity::class.java))
                    awaitCancellation()
                }
                if (roundJob == null && canConnect) {
                    val owner = api
                    controller.disconnect()
                    cameraReady = false
                    val refreshed = try { owner.state(id!!) }
                    catch (cancel: CancellationException) { throw cancel }
                    catch (cause: Exception) {
                        healthy = false; error = userError(cause, "后台连接中断，请检查网络"); render(); delay(1_000); continue
                    }
                    if (owner !== api || id != mirrorId) continue
                    if (!stopBusy) adoptState(refreshed)
                    val current = state ?: continue
                    val currentKey = generationKey(id!!, current)
                    val currentLook = selectedLook(current) ?: continue
                    if (stopBusy || !healthy || previewFailed || current.string("phase") != "generating" || current.string("providerMode") != "xmax" ||
                        (current.optJSONObject("lifecycle")?.optLong("retryAt", 0) ?: 0) > System.currentTimeMillis() ||
                        currentKey != activeKey || currentKey in attempted || current.optJSONObject("live") != null ||
                        current.optLong("generationNumber") <= (stoppedGeneration[id] ?: -1)) continue
                    error = ""
                    attempted.add(currentKey)
                    runningApi = api
                    runningMirror = id
                    currentPosition = position
                    currentDeviceId = cameraDeviceId
                    val instance = NativeGenerationRound(owner, id, deviceId, JSONObject(current.toString()),
                        JSONObject(currentLook.toString()), controller,
                        onStatus = { text -> runOnUiThread { generationStatus = text; if (text == "实时生成") error = ""; render() } },
                        onError = { text -> runOnUiThread { error = text; render() } },
                        onFirstFrame = { runOnUiThread { generationStatus = "实时生成"; error = ""; render() } },
                        cameraPosition = position, cameraDeviceId = activeCameraDeviceId)
                    round = instance
                    roundJob = launch {
                        try { instance.run() }
                        catch (cancel: CancellationException) { throw cancel }
                        catch (_: Exception) { /* The round has reported the failure and settled its reservation. */ }
                    }
                    render()
                } else if (!cameraSettingsOpen && !controller.hasReleaseFailure && roundJob == null && latest?.string("providerMode") == "xmax" && latest.string("experienceMode") != "mox" && hasCameraPermission() && !previewFailed &&
                    (!cameraReady || currentPosition != position || currentDeviceId != cameraDeviceId)) {
                    currentPosition = position
                    controller.onFirstFrame = null
                    controller.onError = { runOnUiThread {
                        cameraReady = false; previewFailed = true; error = "摄像头已断开，点状态重试"
                        reportCamera("error", "摄像头已断开，请重新检测"); render()
                    } }
                    try {
                        withTimeout(15_000) {
                            if (!prefs.contains("native-camera-id")) {
                                val devices = controller.detectCameras().devices
                                val migrated = NativeCameraSelection.migrate(null, prefs.getString("native-camera", null), devices)
                                cameraDeviceId = migrated.cameraId
                                prefs.edit().putString("native-camera-id", migrated.storedValue).apply()
                            }
                            currentDeviceId = cameraDeviceId
                            activeCameraDeviceId = controller.preview(position, cameraDeviceId)
                        }
                        cameraReady = true
                        reportCamera("ready")
                        if (error.startsWith("摄像头") || error == "请允许摄像头权限") error = ""
                    } catch (_: TimeoutCancellationException) {
                        previewFailed = true
                        error = "摄像头未就绪，点状态重试"
                        reportCamera("error", "摄像头未就绪，请重新检测")
                    } catch (cancel: CancellationException) { throw cancel }
                    catch (cause: Exception) {
                        previewFailed = true
                        error = "摄像头不可用，点状态重试"
                        reportCamera("error", "摄像头不可用，请重新检测")
                    }
                    render()
                }
                delay(200)
            }
        } finally {
            withContext(NonCancellable) {
                roundJob?.cancelAndJoin()
                roundJob = null
                round = null
                controller.onFirstFrame = null
                controller.onError = null
                runCatching { controller.close() }.onFailure { error = "摄像头释放失败，请重新打开应用" }
                cameraReady = false
                generationStatus = ""
            }
        }
    }

    private fun command(action: String, lookId: String? = null) {
        val id = mirrorId ?: return
        val snapshot = state ?: return
        val stopping = action in listOf("end", "idle")
        if (stopBusy || (actionBusy && !stopping)) return
        val owner = api
        val epoch = ++actionEpoch
        if (stopping) {
            attempted.add(generationKey(id, snapshot))
            val pendingGeneration = snapshot.optLong("generationNumber") +
                if (actionBusy && actionName in listOf("begin", "resume", "switch", "next", "previous")) 1 else 0
            stoppedGeneration[id] = maxOf(stoppedGeneration[id] ?: -1, pendingGeneration)
            // An abandoned start response cannot restart this terminal after a stop.
            if (actionBusy && actionName in listOf("begin", "resume", "switch", "next", "previous")) {
                val predicted = JSONObject(snapshot.toString())
                    .put("generationNumber", snapshot.optLong("generationNumber") + 1)
                    .put("sessionNumber", snapshot.optLong("sessionNumber") + if (actionName == "begin") 1 else 0)
                attempted.add(generationKey(id, predicted))
            }
            actionJob?.cancel()
            roundJob?.cancel()
            stopBusy = true
        }
        actionBusy = true
        actionName = action
        error = ""
        render()
        actionJob = workScope()?.launch {
            try {
                // End takes effect locally before waiting for the network.
                if (stopping) {
                    state = JSONObject(snapshot.toString()).put("phase", if (action == "idle") "idle" else "select")
                    render()
                }
                val updated = owner.command(id, action, snapshot.optLong("revision"), lookId)
                if (owner === api && id == mirrorId && epoch == actionEpoch) {
                    adoptState(updated)
                    if (!stopping && updated.optLong("generationNumber") > snapshot.optLong("generationNumber")) {
                        attempted.remove(generationKey(id, updated))
                        if (updated.optLong("generationNumber") <= (stoppedGeneration[id] ?: -1)) {
                            stoppedGeneration[id] = updated.optLong("generationNumber") - 1
                        }
                    }
                }
                if (stopping && round == null) {
                    val pending = snapshot.optJSONObject("live")?.string("sessionId").orEmpty()
                    if (pending.isNotEmpty()) owner.stopSession(id, pending)
                }
            } catch (cancel: CancellationException) { throw cancel }
            catch (cause: Exception) { if (epoch == actionEpoch) error = userError(cause, "操作未完成，请重试") }
            finally {
                if (epoch == actionEpoch) { actionBusy = false; stopBusy = false; actionName = "" }
                render()
            }
        }
        if (actionJob == null) { actionBusy = false; stopBusy = false; actionName = ""; render() }
    }

    private fun workScope(): CoroutineScope? = work?.takeIf { it.isActive }?.let { CoroutineScope(it + Dispatchers.Main.immediate) }

    private fun startOrStop() {
        val current = state ?: return
        if (actionBusy) { command("end"); return }
        if (current.optJSONObject("live")?.optBoolean("localEnded") == true) { command("recover"); return }
        if (current.optJSONObject("live") != null && round == null) { command("end"); return }
        when (current.string("phase")) {
            "generating", "showcase", "positioning" -> command("end")
            "paused" -> command("end")
            else -> command("begin")
        }
    }

    private fun step(direction: Int) {
        val snapshot = state ?: return
        if (snapshot.string("phase") == "showcase") {
            command(if (direction > 0) "next" else "previous")
        } else {
            val all = enabledLooks(snapshot)
            if (all.isEmpty()) return
            val index = all.indexOfFirst { it.string("id") == snapshot.string("selectedLookId") }
            command("select", all[Math.floorMod(index + direction, all.size)].string("id"))
        }
    }

    @Suppress("DEPRECATION")
    private fun buildInterface() {
        MirrorImmersive.apply(window)
        kiosk = MirrorKioskView(this)
        video = kiosk.video
        demoImage = kiosk.poster
        skin = kiosk.skin
        pairing = kiosk.pairing
        pairTitle = kiosk.pairTitle
        pairCode = kiosk.pairCode
        primary = kiosk.primary
        status = kiosk.status
        kiosk.logo.setOnLongClickListener { showSettings(); true }
        primary.setOnClickListener { startOrStop() }
        kiosk.continueButton.setOnClickListener { command("resume") }
        kiosk.home.setOnClickListener { command("idle") }
        kiosk.drawer.bindImage = { target, path -> bindImage(target, path, 512) }
        kiosk.drawer.onSelect = { id ->
            if (id != state?.string("selectedLookId")) {
                command(if (state?.string("phase") in listOf("generating", "showcase")) "switch" else "select", id)
            }
        }
        status.setOnClickListener {
            if ((state?.optJSONObject("lifecycle")?.optLong("idleEndsAt", 0) ?: 0) > 0) { command("keepalive"); return@setOnClickListener }
            if (round != null) { if (round?.retryUpdate() == true) { error = ""; render() }; return@setOnClickListener }
            previewFailed = false; cameraReady = false; error = ""
            if (!hasCameraPermission()) requestPermissions(arrayOf(Manifest.permission.CAMERA), 41)
            restartWork()
            render()
        }
        setContentView(kiosk)
    }

    private fun render() {
        if (destroyed || !::status.isInitialized) return
        val snapshot = state
        val bound = mirrorId != null
        val phase = snapshot?.string("phase").orEmpty()
        val mode = snapshot?.string("experienceMode").orEmpty()
        val live = snapshot?.optJSONObject("live")
        val selected = selectedLook(snapshot)
        status.text = when {
            (snapshot?.optJSONObject("lifecycle")?.optLong("idleEndsAt", 0) ?: 0) > 0 -> "即将返回待机，点此继续体验"
            error.isNotBlank() -> error
            !healthy -> "连接后台…"
            !bound -> "待绑定"
            live?.optBoolean("localEnded") == true -> "云端状态待确认"
            live != null && round == null -> "等待会话释放"
            generationStatus.isNotBlank() -> generationStatus
            snapshot?.string("providerMode") == "demo" -> "演示模式"
            snapshot?.string("providerMode") == "xmax" && provider?.optBoolean("configured") == false -> "请在后台配置 XMAX"
            phase == "paused" -> "已暂停"
            cameraReady -> "本地取景"
            !hasCameraPermission() -> "请允许摄像头权限"
            else -> "准备摄像头…"
        }
        status.setTextColor(if (error.isBlank()) MUTED else Color.rgb(175, 60, 65))
        pairing.visibility = if (bound) View.GONE else View.VISIBLE
        pairTitle.text = if (healthy) "设备绑定" else "连接后台"
        pairCode.text = bindingCode.ifBlank { "····" }
        val demo = snapshot?.string("providerMode") == "demo"
        val realtime = snapshot?.string("providerMode") == "xmax"
        val imageInput = mode == "mox" && round == null
        val presentation = NativeMirrorUiState.resolve(realtime, imageInput, cameraReady, round != null,
            phase, actionBusy, stopBusy, live != null, live?.optBoolean("localEnded") == true)
        demoImage.visibility = if (presentation.showPoster) View.VISIBLE else View.GONE
        // Transparent posters use the same light stage as the web; an idle video surface is black.
        video.visibility = if (demo || imageInput) View.GONE else View.VISIBLE
        if (presentation.showPoster) bindImage(demoImage, selected?.string("image"), 1920)
        val settings = snapshot?.optJSONObject("settings")
        val customSkin = settings?.optJSONObject("uiSkin")?.string("image").orEmpty()
        kiosk.applySkin(settings?.string("uiSkinPreset").orEmpty().ifBlank { "crystal" }, customSkin.isNotBlank())
        if (customSkin.isNotBlank()) bindImage(skin, customSkin, 1920)
        kiosk.empty.visibility = if (bound && selected == null) View.VISIBLE else View.GONE
        val missingCameraPermission = realtime && mode != "mox" && !hasCameraPermission()
        val missingCredential = realtime && provider?.optBoolean("configured") == false
        kiosk.status.visibility = if ((snapshot?.optJSONObject("lifecycle")?.optLong("idleEndsAt", 0) ?: 0) > 0 ||
            error.isNotBlank() || !healthy || live != null || generationStatus.isNotBlank() || missingCameraPermission || missingCredential) View.VISIBLE else View.GONE
        val busy = phase in listOf("generating", "showcase", "positioning") || round != null
        val blocked = live != null
        primary.text = presentation.primaryText
        primary.visibility = if (bound) View.VISIBLE else View.GONE
        kiosk.setPrimaryIcon(presentation.stopIcon, presentation.recoverIcon)
        val canStart = !cameraSettingsOpen && !controller.hasReleaseFailure && healthy && selected != null && (!realtime || mode == "mox" || cameraReady) &&
            (!realtime || provider?.optBoolean("configured") == true)
        primary.isEnabled = !stopBusy && bound && snapshot != null && (actionBusy || busy || blocked || phase == "paused" || canStart)
        kiosk.continueButton.visibility = if (bound && presentation.showContinue) View.VISIBLE else View.GONE
        kiosk.continueButton.isEnabled = !actionBusy && !stopBusy && canStart
        kiosk.home.visibility = if (bound && phase !in listOf("idle", "select", "")) View.VISIBLE else View.GONE
        kiosk.home.isEnabled = !stopBusy
        val canSelect = !actionBusy && healthy && phase in listOf("idle", "select", "generating", "showcase") && !blockedUnlessOwn(live)
        kiosk.drawer.visibility = if (bound && selected != null) View.VISIBLE else View.GONE
        if (!bound || mode != lastUiMode) kiosk.drawer.setOpen(false)
        lastUiMode = mode
        kiosk.drawer.submit(enabledLooks(snapshot), snapshot?.string("selectedLookId").orEmpty(),
            settings?.optInt("materialDrawerColumns", 2) ?: 2, canSelect, if (mode == "clothx") "选择服装" else "选择素材")
    }

    private fun blockedUnlessOwn(live: JSONObject?) = live != null && live.string("deviceId") != deviceId

    private fun cameraIsLocked() = controller.hasReleaseFailure || roundJob != null || round != null || actionBusy || stopBusy ||
        state?.optJSONObject("live") != null || state?.string("phase") in listOf("generating", "showcase", "positioning", "paused")

    private fun reportCamera(status: String, message: String? = null) {
        remoteCamera.update(status, cameraSnapshot, NativeCameraSelection(cameraDeviceId),
            activeCameraDeviceId.takeIf { cameraReady }, message)
    }

    private fun handleRemoteCameraRequest(value: JSONObject) {
        val request = remoteCamera.consume(value, terminalId, System.currentTimeMillis(),
            !started || settingsDialog != null || state == null || cameraIsLocked())
        // Write before opening so a process restart cannot reopen the same staff request.
        if (!prefs.edit().putStringSet("native-camera-handled-requests", remoteCamera.handledRequests()).commit()) {
            remoteCamera.update("error", cameraSnapshot, NativeCameraSelection(cameraDeviceId), null, "无法保存摄像头检测状态")
            return
        }
        if (request != null) showSettings(request)
    }

    private fun showSettings(remoteRequest: NativeCameraOpenRequest? = null) {
        if (settingsDialog != null) return
        val cameraLocked = cameraIsLocked()
        remoteCameraRequest = remoteRequest
        val reportBinding = remoteCamera.bindingKey()
        val reportApi = api
        val reportRequestId = remoteCamera.requestId()
        fun ownsReport() = reportApi === api && reportBinding == remoteCamera.bindingKey() &&
            (remoteRequest == null || reportRequestId == remoteCamera.requestId())
        if (!cameraLocked) {
            cameraSettingsOpen = true
            cameraReady = false
            restartWork()
        }
        val cameraReleased = shutdown
        val content = NativeDeviceSettingsView(this, remoteRequest != null)
        val address = content.address.apply { setText(screenUrl) }
        val backendIp = content.backendIp.apply { setText(prefs.getString("backend-ip", "")) }
        val cameraPanel = if (!cameraLocked) NativeCameraSettingsPanel(
            this, controller, NativeCameraSelection(cameraDeviceId), prefs.getString("native-camera", null),
            migrateLegacy = !prefs.contains("native-camera-id"),
            awaitExclusive = { cameraReleased?.join() },
            requestPermission = {
                if (hasCameraPermission()) true else {
                    requestPermissions(arrayOf(Manifest.permission.CAMERA), 41)
                    false
                }
            },
            onState = { status, snapshot, selection, activeId, message ->
                if (ownsReport()) {
                    cameraSnapshot = snapshot
                    remoteCamera.update(status, snapshot, selection, activeId, message)
                    if (status == "error" && controller.hasReleaseFailure) settingsDialog?.dismiss()
                }
            },
        ).also { content.cameraContainer.addView(it, LinearLayout.LayoutParams(-1, -2)) } else null
        cameraSettingsPanel = cameraPanel
        if (cameraLocked) content.cameraContainer.addView(label(if (controller.hasReleaseFailure) "摄像头释放失败，请重新打开应用" else "停止生成后可选择摄像头", 13, MUTED, false))
        content.meta.text = "原生版 ${BuildConfig.VERSION_NAME} · ${Build.MODEL}"
        val dialog = MirrorSettingsDialog(this, content)
        content.cancelButton.setOnClickListener { dialog.cancel() }
        settingsDialog = dialog
        var saved = false
        dialog.setOnDismissListener {
            remoteCameraExpiry?.cancel()
            remoteCameraExpiry = null
            settingsDialog = null
            cameraSettingsPanel = null
            cameraSettingsOpen = false
            if (cameraPanel != null) {
                cameraSettingsCleanup = cleanupScope.launch {
                    runCatching { cameraPanel.close() }.onFailure {
                        previewFailed = true
                        error = "摄像头释放失败，请重新打开应用"
                        if (ownsReport()) {
                            remoteCamera.update("error", cameraSnapshot, NativeCameraSelection(cameraDeviceId), null, error)
                        }
                        render()
                    }
                }
                cameraReady = false
                activeCameraDeviceId = null
                previewFailed = false
                if (error.startsWith("摄像头") || error.startsWith("所选摄像头")) error = ""
                if (ownsReport()) {
                    remoteCamera.update(if (controller.hasReleaseFailure) "error" else "closed", cameraSnapshot,
                        NativeCameraSelection(cameraDeviceId), null,
                        if (controller.hasReleaseFailure) "摄像头释放失败，请重新打开应用" else null)
                }
            }
            if (cameraPanel != null || saved) restartWork()
            render()
            window.decorView.post { if (!destroyed) MirrorImmersive.apply(window) }
        }
        dialog.setOnShowListener {
            content.saveButton.setOnClickListener {
                val fallbackIp = backendIp.text.toString().trim()
                try { if (fallbackIp.isNotEmpty()) LanBackendAddress.requirePrivateIpv4(fallbackIp) }
                catch (_: IllegalArgumentException) {
                    backendIp.error = "请输入局域网 IPv4 地址"
                    return@setOnClickListener
                }
                try {
                    val url = UrlPolicy.cameraScreenUrl(address.text.toString())
                    // Constructor validates the endpoint before a running terminal is interrupted.
                    ExhibitionApi(url, terminalId, terminalToken, Build.MODEL, LanBackendDns(applicationContext, url, fallbackIp))
                    val preferences = prefs.edit().putString("screen-url", url).putString("backend-ip", fallbackIp)
                    if (cameraPanel != null) {
                        preferences.putString("native-camera-id", cameraPanel.selection.storedValue)
                    }
                    check(preferences.commit()) { "无法保存摄像头设置" }
                    screenUrl = url
                    if (cameraPanel != null) cameraDeviceId = cameraPanel.selection.cameraId
                    saved = true
                    if (remoteRequest == null) {
                        api = newApi()
                        remoteCamera.bind(null, null)
                        mirrorId = null; state = null; provider = null; healthy = false; error = ""; backendError = ""; previewFailed = false
                        imageCache.evictAll()
                    }
                    dialog.dismiss()
                } catch (cause: IllegalArgumentException) { address.error = cause.message ?: "网址无效" }
                catch (_: IllegalStateException) { Toast.makeText(this, "无法保存摄像头设置", Toast.LENGTH_SHORT).show() }
            }
        }
        dialog.show()
        if (remoteRequest != null) {
            remoteCameraExpiry = cleanupScope.launch {
                delay((remoteRequest.expiresAt - System.currentTimeMillis()).coerceAtLeast(0))
                if (settingsDialog === dialog) dialog.dismiss()
            }
        }
    }

    private fun bindImage(target: ImageView, path: String?, maxSide: Int = 256, scope: CoroutineScope = imageScope) {
        val key = if (path.isNullOrBlank()) "" else "$screenUrl|$maxSide|$path"
        if (target.tag == key) return
        target.tag = key
        target.setImageDrawable(null)
        if (key.isEmpty()) return
        imageCache.get(key)?.let { target.setImageBitmap(it); return }
        val owner = api
        scope.launch {
            try {
                val bitmap = imageSlots.withPermit {
                    val bytes = owner.image(path!!)
                    withContext(Dispatchers.Default) {
                        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                        var sample = 1
                        while (max(bounds.outWidth, bounds.outHeight) / sample > maxSide) sample *= 2
                        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
                    }
                }
                if (bitmap != null && owner === api && !destroyed) {
                    imageCache.put(key, bitmap)
                    if (target.tag == key) target.setImageBitmap(bitmap)
                }
            } catch (cancel: CancellationException) { throw cancel }
            catch (_: Exception) {
                if (target.tag == key) target.tag = null
            }
        }
    }

    @Deprecated("Android legacy back callback")
    override fun onBackPressed() {
        if (::kiosk.isInitialized && kiosk.drawer.isOpen) { kiosk.drawer.setOpen(false); return }
        if (round != null || state?.string("phase") in listOf("generating", "showcase", "paused", "positioning")) command("end")
        else super.onBackPressed()
    }

    private fun hasCameraPermission() = checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    private fun adoptState(incoming: JSONObject) {
        if (incoming.optLong("revision", -1) >= (state?.optLong("revision", -1) ?: -1)) state = incoming
    }
    private fun selectedLook(value: JSONObject?): JSONObject? = enabledLooks(value).firstOrNull { it.string("id") == value?.string("selectedLookId") }
    private fun enabledLooks(value: JSONObject?): List<JSONObject> {
        if (value == null) return emptyList()
        val all = value.optJSONArray("looks") ?: return emptyList()
        val enabled = value.optJSONArray("enabledLookIds") ?: return emptyList()
        val index = (0 until all.length()).mapNotNull { all.optJSONObject(it) }.associateBy { it.string("id") }
        return (0 until enabled.length()).mapNotNull { index[enabled.optString(it)] }
            .filter { it.string("mode").ifBlank { "clothx" } == value.string("experienceMode").ifBlank { "clothx" } }
    }
    private fun generationKey(id: String, value: JSONObject) = "$id:${value.optLong("sessionNumber")}:${value.optLong("generationNumber")}:${value.string("selectedLookId")}:${value.string("experienceMode").ifBlank { "clothx" }}"
    private fun JSONObject.string(key: String) = if (isNull(key)) "" else optString(key, "")
    private fun userError(cause: Exception, fallback: String) = if (cause is ExhibitionApiException) cause.message ?: fallback else fallback
    private fun dp(value: Int) = (value * resources.displayMetrics.density + .5f).toInt()
    private fun rounded(color: Int, radius: Int) = GradientDrawable().apply { setColor(color); cornerRadius = dp(radius).toFloat() }
    private fun label(value: String, size: Int, color: Int, bold: Boolean) = TextView(this).apply {
        text = value; textSize = size.toFloat(); setTextColor(color); gravity = Gravity.CENTER_VERTICAL
        if (bold) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    }
    private fun button(value: String, filled: Boolean) = Button(this).apply {
        text = value; textSize = 16f; isAllCaps = false; stateListAnimator = null
        setTextColor(if (filled) Color.WHITE else PURPLE)
        background = rounded(if (filled) PURPLE else Color.WHITE, 18)
        setPadding(dp(6), 0, dp(6), 0)
    }
    companion object {
        private val PURPLE = Color.rgb(116, 82, 214)
        private val CREAM = Color.rgb(247, 245, 251)
        private val DARK = Color.rgb(38, 30, 54)
        private val MUTED = MirrorUiTheme.MUTED
    }
}
