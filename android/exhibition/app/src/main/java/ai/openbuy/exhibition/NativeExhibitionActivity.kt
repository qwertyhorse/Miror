package ai.openbuy.exhibition

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
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
    private lateinit var title: TextView
    private lateinit var modeLabel: TextView
    private lateinit var pairing: LinearLayout
    private lateinit var pairTitle: TextView
    private lateinit var pairCode: TextView
    private lateinit var selectedName: TextView
    private lateinit var selectedImage: ImageView
    private lateinit var demoImage: ImageView
    private lateinit var skin: ImageView
    private lateinit var primary: Button
    private lateinit var previous: Button
    private lateinit var next: Button
    private lateinit var materials: LinearLayout
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
    private var error = ""
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
        terminalId = prefs.getString("terminal-id", null) ?: "terminal-${UUID.randomUUID()}"
        terminalToken = prefs.getString("terminal-token", null) ?: "${UUID.randomUUID()}${UUID.randomUUID()}"
        check(prefs.edit().putString("terminal-id", terminalId).putString("terminal-token", terminalToken).commit())
        screenUrl = runCatching {
            val saved = UrlPolicy.cameraScreenUrl(prefs.getString("screen-url", UrlPolicy.DEFAULT_URL))
            ExhibitionApi(saved, terminalId, terminalToken, Build.MODEL)
            saved
        }
            .getOrDefault(UrlPolicy.DEFAULT_URL)
        position = if (prefs.getString("native-camera", "back") == "front") CameraPosition.FRONT else CameraPosition.BACK
        api = newApi()
        buildInterface()
        controller = NativeXmaxController(this, video)
        render()
    }

    private fun newApi() = ExhibitionApi(screenUrl, terminalId, terminalToken, "${Build.MANUFACTURER} ${Build.MODEL}".take(80))

    override fun onStart() {
        super.onStart()
        started = true
        restartWork()
        if (!hasCameraPermission() && !permissionAsked) {
            permissionAsked = true
            requestPermissions(arrayOf(Manifest.permission.CAMERA), 41)
        }
    }

    override fun onStop() {
        started = false
        restartWork()
        super.onStop()
    }

    override fun onDestroy() {
        destroyed = true
        restartEpoch++
        imageScope.cancel()
        imageCache.evictAll()
        cleanupScope.launch { shutdown?.join(); cleanupScope.cancel() }
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 41) {
            previewFailed = false
            error = if (hasCameraPermission()) "" else "请允许摄像头权限"
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
        shutdown = cleanupScope.launch {
            preceding?.join()
            old?.join()
            if (requestedEpoch == restartEpoch && started && !destroyed) {
                work = cleanupScope.launch {
                    try {
                        supervisorScope {
                            val poller = launch { pollBackend() }
                            try { runEngine() } finally { poller.cancelAndJoin() }
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
        while (currentCoroutineContext().isActive) {
            val owner = api
            try {
                val now = android.os.SystemClock.elapsedRealtime()
                if (now - lastBinding >= 10_000 || mirrorId == null) {
                    val binding = owner.connectTerminal()
                    if (owner !== api) continue
                    val incoming = binding.string("mirrorId").ifBlank { null }
                    if (incoming != mirrorId) {
                        mirrorId = incoming
                        state = null
                        provider = null
                        lastProvider = 0
                    }
                    mirrorName = binding.string("mirrorName").ifBlank { "展会试衣镜" }
                    bindingCode = binding.string("code")
                    lastBinding = now
                }
                val id = mirrorId
                if (id != null) {
                    val fresh = state?.let { owner.changes(id, it.optLong("revision", 0)) } ?: owner.state(id)
                    if (owner !== api || id != mirrorId) continue
                    if (!stopBusy) adoptState(fresh)
                    if (now - lastProvider >= 10_000) {
                        provider = owner.liveStatus(id)
                        lastProvider = now
                    }
                }
                if (!healthy && error.startsWith("后台")) error = ""
                healthy = true
                render()
                delay(if (id == null) 10_000 else 100)
            } catch (cancel: CancellationException) { throw cancel }
            catch (cause: Exception) {
                if (owner === api) {
                    healthy = false
                    error = userError(cause, "后台连接中断，请检查网络")
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
        try {
            while (isActive) {
                val latest = state
                val id = mirrorId
                val activeKey = if (id != null && latest != null) generationKey(id, latest) else null
                val currentSelection = selectedLook(latest)
                val reusable = latest != null && currentSelection != null && round?.canReuse(latest, currentSelection) == true
                val valid = healthy && latest?.string("providerMode") == "xmax" &&
                    latest.string("phase") in listOf("generating", "showcase") &&
                    runningApi === api && runningMirror == id && (round?.key == activeKey || reusable) && currentPosition == position
                if (roundJob != null && (!valid || roundJob?.isCompleted == true)) {
                    roundJob?.cancelAndJoin()
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
                val canConnect = healthy && id != null && latest != null && look != null &&
                    latest.string("phase") == "generating" && latest.string("providerMode") == "xmax" &&
                    activeKey !in attempted && latest.optLong("generationNumber") > (stoppedGeneration[id] ?: -1) &&
                    !stopBusy && live == null && (!needsCamera || cameraReady)
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
                    if (stopBusy || !healthy || current.string("phase") != "generating" || current.string("providerMode") != "xmax" ||
                        currentKey != activeKey || currentKey in attempted || current.optJSONObject("live") != null ||
                        current.optLong("generationNumber") <= (stoppedGeneration[id] ?: -1)) continue
                    error = ""
                    attempted.add(currentKey)
                    runningApi = api
                    runningMirror = id
                    currentPosition = position
                    val instance = NativeGenerationRound(owner, id, deviceId, JSONObject(current.toString()),
                        JSONObject(currentLook.toString()), controller,
                        onStatus = { text -> runOnUiThread { generationStatus = text; if (text == "实时生成") error = ""; render() } },
                        onError = { text -> runOnUiThread { error = text; render() } },
                        onFirstFrame = { runOnUiThread { generationStatus = "实时生成"; error = ""; render() } },
                        cameraPosition = position)
                    round = instance
                    roundJob = launch {
                        try { instance.run() }
                        catch (cancel: CancellationException) { throw cancel }
                        catch (_: Exception) { /* The round has reported the failure and settled its reservation. */ }
                    }
                    render()
                } else if (roundJob == null && latest?.string("experienceMode") != "mox" && hasCameraPermission() && !previewFailed &&
                    (!cameraReady || currentPosition != position)) {
                    currentPosition = position
                    controller.onFirstFrame = null
                    controller.onError = { runOnUiThread {
                        cameraReady = false; previewFailed = true; error = "摄像头已断开，点状态重试"; render()
                    } }
                    try {
                        withTimeout(15_000) { controller.preview(position) }
                        cameraReady = true
                        if (error.startsWith("摄像头") || error == "请允许摄像头权限") error = ""
                    } catch (_: TimeoutCancellationException) {
                        previewFailed = true
                        error = "摄像头未就绪，点状态重试"
                    } catch (cancel: CancellationException) { throw cancel }
                    catch (cause: Exception) {
                        previewFailed = true
                        error = "摄像头不可用，点状态重试"
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
        val stopping = action == "end"
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
                if (action == "end") {
                    state = JSONObject(snapshot.toString()).put("phase", "select")
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
                if (action == "end" && round == null) {
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
        if (current.optJSONObject("live") != null && round == null) { command("end"); return }
        when (current.string("phase")) {
            "generating", "showcase", "positioning" -> command("end")
            "paused" -> if (current.optJSONObject("live") == null) command("resume") else command("end")
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

    private fun buildInterface() {
        val frame = FrameLayout(this).apply { setBackgroundColor(CREAM) }
        skin = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP; alpha = .42f }
        frame.addView(skin, FrameLayout.LayoutParams(-1, -1))
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(16), dp(18), dp(18))
            setOnApplyWindowInsetsListener { view, insets ->
                @Suppress("DEPRECATION")
                view.setPadding(dp(18) + insets.systemWindowInsetLeft, dp(12) + insets.systemWindowInsetTop,
                    dp(18) + insets.systemWindowInsetRight, dp(18) + insets.systemWindowInsetBottom)
                insets
            }
        }
        frame.addView(column, FrameLayout.LayoutParams(-1, -1))
        val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        title = label("OpenBuy", 25, DARK, true)
        header.addView(title, LinearLayout.LayoutParams(0, dp(48), 1f))
        val settings = button("设置", false).apply { setOnClickListener { showSettings() }; contentDescription = "设备设置" }
        header.addView(settings, LinearLayout.LayoutParams(dp(72), dp(44)))
        column.addView(header)
        val meta = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(0, 0, 0, dp(10)) }
        modeLabel = label("ClothX", 12, PURPLE, true)
        meta.addView(modeLabel, LinearLayout.LayoutParams(0, dp(30), 1f))
        status = label("连接后台…", 12, MUTED, false).apply {
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
            setOnClickListener {
                if (round != null) { if (round?.retryUpdate() == true) { error = ""; render() }; return@setOnClickListener }
                previewFailed = false; cameraReady = false; error = ""
                if (!hasCameraPermission()) requestPermissions(arrayOf(Manifest.permission.CAMERA), 41)
                restartWork()
                render()
            }
        }
        meta.addView(status, LinearLayout.LayoutParams(0, dp(30), 3f))
        column.addView(meta)
        val stage = FrameLayout(this).apply { background = rounded(Color.BLACK, 24); clipToOutline = true }
        video = XmaxRealtimeVideoView(this).apply { videoContentMode = VideoContentMode.FIT; isInteractionEnabled = false }
        stage.addView(video, FrameLayout.LayoutParams(-1, -1))
        demoImage = ImageView(this).apply { scaleType = ImageView.ScaleType.FIT_CENTER; visibility = View.GONE }
        stage.addView(demoImage, FrameLayout.LayoutParams(-1, -1))
        pairing = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            setPadding(dp(24), dp(24), dp(24), dp(24)); setBackgroundColor(Color.rgb(246, 243, 253))
        }
        pairTitle = label("设备绑定", 20, DARK, true).apply { gravity = Gravity.CENTER }
        pairCode = label("······", 40, PURPLE, true).apply { gravity = Gravity.CENTER; letterSpacing = .12f }
        pairing.addView(pairTitle)
        pairing.addView(pairCode, LinearLayout.LayoutParams(-1, dp(88)))
        pairing.addView(label("在展会后台绑定此设备", 14, MUTED, false).apply { gravity = Gravity.CENTER })
        stage.addView(pairing, FrameLayout.LayoutParams(-1, -1))
        column.addView(stage, LinearLayout.LayoutParams(-1, 0, 1f))
        materials = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL; setPadding(dp(12), dp(10), dp(12), dp(10))
            background = rounded(Color.WHITE, 18)
            setOnClickListener { showMaterials() }
            contentDescription = "选择素材"
        }
        selectedImage = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP; background = rounded(CREAM, 10); clipToOutline = true }
        materials.addView(selectedImage, LinearLayout.LayoutParams(dp(52), dp(62)))
        selectedName = label("选择素材", 16, DARK, true).apply { setPadding(dp(14), 0, dp(8), 0) }
        materials.addView(selectedName, LinearLayout.LayoutParams(0, -2, 1f))
        materials.addView(label("⌄", 24, PURPLE, true))
        column.addView(materials, LinearLayout.LayoutParams(-1, dp(82)).apply { topMargin = dp(12) })
        val controls = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        previous = button("‹", false).apply { contentDescription = "上一款"; textSize = 30f; setOnClickListener { step(-1) } }
        next = button("›", false).apply { contentDescription = "下一款"; textSize = 30f; setOnClickListener { step(1) } }
        primary = button("开始体验", true).apply { setOnClickListener { startOrStop() } }
        controls.addView(previous, LinearLayout.LayoutParams(dp(54), dp(58)))
        controls.addView(primary, LinearLayout.LayoutParams(0, dp(58), 1f).apply { leftMargin = dp(10); rightMargin = dp(10) })
        controls.addView(next, LinearLayout.LayoutParams(dp(54), dp(58)))
        column.addView(controls, LinearLayout.LayoutParams(-1, dp(58)).apply { topMargin = dp(12) })
        setContentView(frame)
    }

    private fun render() {
        if (destroyed || !::status.isInitialized) return
        val snapshot = state
        val bound = mirrorId != null
        val phase = snapshot?.string("phase").orEmpty()
        val mode = snapshot?.string("experienceMode").orEmpty()
        val live = snapshot?.optJSONObject("live")
        val selected = selectedLook(snapshot)
        title.text = if (bound) mirrorName else "OpenBuy"
        modeLabel.text = mapOf("free" to "Free", "charx" to "CharX", "clothx" to "ClothX", "vibex" to "VibeX", "dimx" to "DimX", "mox" to "MoX")[mode] ?: "ClothX"
        status.text = when {
            error.isNotBlank() -> error
            !healthy -> "连接后台…"
            !bound -> "待绑定"
            live?.optBoolean("localEnded") == true -> "云端状态待确认"
            live != null && round == null -> "等待会话释放"
            generationStatus.isNotBlank() -> generationStatus
            snapshot?.string("providerMode") == "demo" -> "演示模式"
            snapshot?.string("providerMode") == "xmax" && provider?.optBoolean("configured") == false -> "请在后台配置 XMAX"
            phase == "paused" -> "已暂停"
            cameraReady -> "摄像头已就绪"
            !hasCameraPermission() -> "请允许摄像头权限"
            else -> "准备摄像头…"
        }
        status.setTextColor(if (error.isBlank()) MUTED else Color.rgb(175, 60, 65))
        pairing.visibility = if (bound) View.GONE else View.VISIBLE
        pairTitle.text = if (healthy) "设备绑定" else "连接后台"
        pairCode.text = bindingCode.ifBlank { "······" }
        selectedName.text = selected?.string("name")?.ifBlank { "选择素材" } ?: "暂无启用素材"
        bindImage(selectedImage, selected?.string("image"))
        val demo = snapshot?.string("providerMode") == "demo" && phase == "showcase"
        val imageInput = mode == "mox" && round == null
        demoImage.visibility = if (demo || imageInput) View.VISIBLE else View.GONE
        if (demo || imageInput) bindImage(demoImage, selected?.string("image"), 1280)
        bindImage(skin, snapshot?.optJSONObject("settings")?.optJSONObject("uiSkin")?.string("image"), 1280)
        val busy = phase in listOf("generating", "showcase", "positioning") || round != null
        val blocked = live != null
        primary.text = when {
            stopBusy -> "正在停止…"
            actionBusy -> "取消体验"
            busy -> "结束体验"
            blocked -> "重试停止"
            phase == "paused" -> "继续体验"
            else -> "开始体验"
        }
        primary.isEnabled = !stopBusy && bound && snapshot != null && (actionBusy || busy || blocked ||
            (healthy && selected != null && (snapshot.string("providerMode") != "xmax" || mode == "mox" || cameraReady) &&
                (snapshot.string("providerMode") != "xmax" || provider?.optBoolean("configured") == true)))
        primary.alpha = if (primary.isEnabled) 1f else .45f
        val canSelect = !actionBusy && healthy && phase in listOf("idle", "select", "showcase") && !blockedUnlessOwn(live)
        materials.isEnabled = canSelect
        val multiple = enabledLooks(snapshot).size > 1
        previous.isEnabled = canSelect && multiple
        next.isEnabled = canSelect && multiple
        previous.alpha = if (previous.isEnabled) 1f else .4f
        next.alpha = if (next.isEnabled) 1f else .4f
    }

    private fun blockedUnlessOwn(live: JSONObject?) = live != null && live.string("deviceId") != deviceId

    private fun showMaterials() {
        val snapshot = state ?: return
        if (!materials.isEnabled) return
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(14), dp(8), dp(14), dp(8)) }
        val dialogImages = CoroutineScope(imageScope.coroutineContext + SupervisorJob(imageScope.coroutineContext[Job]))
        val dialog = AlertDialog.Builder(this).setTitle("选择素材").setView(ScrollView(this).apply { addView(list) }).setNegativeButton("关闭", null).create()
        dialog.setOnDismissListener { dialogImages.cancel() }
        enabledLooks(snapshot).forEach { look ->
            val row = LinearLayout(this).apply {
                gravity = Gravity.CENTER_VERTICAL; setPadding(dp(8), dp(8), dp(8), dp(8))
                background = rounded(if (look.string("id") == snapshot.string("selectedLookId")) Color.rgb(239, 231, 255) else Color.WHITE, 12)
                setOnClickListener {
                    dialog.dismiss()
                    if (look.string("id") != state?.string("selectedLookId")) command(if (state?.string("phase") == "showcase") "switch" else "select", look.string("id"))
                }
            }
            val image = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
            row.addView(image, LinearLayout.LayoutParams(dp(64), dp(80)))
            row.addView(label(look.string("name"), 16, DARK, true).apply { setPadding(dp(16), 0, 0, 0) }, LinearLayout.LayoutParams(0, -2, 1f))
            list.addView(row, LinearLayout.LayoutParams(-1, dp(98)).apply { bottomMargin = dp(5) })
            bindImage(image, look.string("image"), 128, dialogImages)
        }
        dialog.show()
    }

    private fun showSettings() {
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(22), dp(12), dp(22), 0) }
        box.addView(label("展台网址", 13, MUTED, false))
        val address = EditText(this).apply { setText(screenUrl); textSize = 14f; inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI; setSingleLine(false) }
        box.addView(address, LinearLayout.LayoutParams(-1, -2))
        val cameras = RadioGroup(this).apply { orientation = RadioGroup.HORIZONTAL }
        val back = RadioButton(this).apply { id = View.generateViewId(); text = "后置镜头" }
        val front = RadioButton(this).apply { id = View.generateViewId(); text = "前置镜头" }
        cameras.addView(back); cameras.addView(front)
        cameras.check(if (position == CameraPosition.FRONT) front.id else back.id)
        box.addView(cameras)
        box.addView(label("原生版 0.2.0 · ${Build.MODEL}", 12, MUTED, false))
        val dialog = AlertDialog.Builder(this).setTitle("设备设置").setView(box).setNegativeButton("取消", null).setPositiveButton("保存", null).create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                try {
                    val url = UrlPolicy.cameraScreenUrl(address.text.toString())
                    // Constructor validates the endpoint before a running terminal is interrupted.
                    ExhibitionApi(url, terminalId, terminalToken, Build.MODEL)
                    screenUrl = url
                    position = if (cameras.checkedRadioButtonId == front.id) CameraPosition.FRONT else CameraPosition.BACK
                    prefs.edit().putString("screen-url", screenUrl).putString("native-camera", if (position == CameraPosition.FRONT) "front" else "back").apply()
                    api = newApi()
                    mirrorId = null; state = null; provider = null; healthy = false; error = ""; previewFailed = false
                    imageCache.evictAll()
                    restartWork()
                    render()
                    dialog.dismiss()
                } catch (cause: IllegalArgumentException) { address.error = cause.message ?: "网址无效" }
            }
        }
        dialog.show()
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
        private val MUTED = Color.rgb(119, 110, 133)
    }
}
