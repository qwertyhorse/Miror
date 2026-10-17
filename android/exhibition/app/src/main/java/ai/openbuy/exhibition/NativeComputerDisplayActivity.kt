package ai.openbuy.exhibition

import android.app.Activity
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.ArrayAdapter
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.Toast
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import kotlin.math.max

/** A display and control terminal only. It never creates a camera, gesture model or XMAX session. */
class NativeComputerDisplayActivity : Activity() {
    private lateinit var prefs: SharedPreferences
    private lateinit var api: ExhibitionApi
    private lateinit var kiosk: MirrorKioskView
    private lateinit var pageLayer: FrameLayout
    private lateinit var screenUrl: String
    private lateinit var terminalId: String
    private lateinit var terminalToken: String
    private var work: CoroutineScope? = null
    private var mirrorId: String? = null
    private var state: JSONObject? = null
    private var provider: JSONObject? = null
    private var bindingCode = ""
    private var healthy = false
    private var commandBusy = false
    private var commandJob: Job? = null
    private var commandEpoch = 0L
    private var error = ""
    private var backendError = ""
    private var receiverId = UUID.randomUUID().toString()
    private var sessionId: String? = null
    private var computerDeviceId = ""
    private var signalCursor = 0L
    private var signalEpoch = 0L
    private var receiver: NativeComputerVideoReceiver? = null
    private var videoReady = false
    private var computerPresentation = NativeComputerPresentation.from()
    private val imageSource get() = computerPresentation.isImage
    private data class PageReceipt(val session: String, val receiver: String, val epoch: Long, val presentationId: Long)
    private var renderedPageReceipt: PageReceipt? = null
    private var sentPageReceipt: PageReceipt? = null
    private var sendingPageReceipt: PageReceipt? = null
    private var lastMode = ""
    private var settingsDialog: MirrorSettingsDialog? = null
    private val signalLock = Mutex()
    private val imageSlots = Semaphore(2)
    private val pendingImages = mutableMapOf<ImageView, Any>()
    private val images = object : android.util.LruCache<String, Bitmap>(12 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = max(1, value.allocationByteCount / 1024)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        MirrorImmersive.apply(window)
        prefs = getSharedPreferences("exhibition-device", MODE_PRIVATE)
        terminalId = prefs.getString("terminal-id", null) ?: "terminal-${UUID.randomUUID()}"
        terminalToken = prefs.getString("terminal-token", null) ?: "${UUID.randomUUID()}${UUID.randomUUID()}"
        check(prefs.edit().putString("terminal-id", terminalId).putString("terminal-token", terminalToken).commit())
        screenUrl = runCatching { UrlPolicy.migrateDefaultScreenUrl(prefs.getString("screen-url", null)) }.getOrDefault(UrlPolicy.DEFAULT_URL)
        api = ExhibitionApi(screenUrl, terminalId, terminalToken, "${Build.MODEL} · 电脑显示",
            LanBackendDns(applicationContext, screenUrl, prefs.getString("backend-ip", "")))
        kiosk = MirrorKioskView(this)
        kiosk.video.visibility = View.GONE
        kiosk.logo.setOnLongClickListener { showSettings(); true }
        kiosk.primary.setOnClickListener { startOrStop() }
        kiosk.stopButton.setOnClickListener { startOrStop() }
        kiosk.continueButton.setOnClickListener { command("resume") }
        kiosk.home.setOnClickListener { command("idle") }
        kiosk.status.setOnClickListener {
            if ((state?.optJSONObject("lifecycle")?.optLong("idleEndsAt", 0) ?: 0) > 0) command("keepalive")
            else { resetReceiver(); receiverId = UUID.randomUUID().toString(); error = ""; render() }
        }
        kiosk.drawer.bindImage = { target, path -> bindImage(target, path, 512) }
        kiosk.drawer.onSelect = { id -> if (id != state?.string("selectedLookId"))
            command(if (state?.string("phase") in listOf("generating", "showcase")) "switch" else "select", id) }
        pageLayer = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            contentDescription = "无线投屏，长按打开设备设置"
            setOnLongClickListener { showSettings(); true }
        }
        setContentView(FrameLayout(this).apply {
            addView(pageLayer, FrameLayout.LayoutParams(-1, -1))
            addView(kiosk, FrameLayout.LayoutParams(-1, -1))
        })
        render()
    }

    override fun onStart() {
        super.onStart()
        // The terminal may have been rebound while this Activity was stopped.
        // No state request or control can use the previous mirror before connect confirms it.
        mirrorId = null; state = null; provider = null; bindingCode = ""
        healthy = false; commandBusy = false; error = ""
        invalidatePendingImages()
        render()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        work = scope
        receiverId = UUID.randomUUID().toString()
        scope.launch { pollBinding() }
        scope.launch { pollState() }
        scope.launch { pollVideo() }
    }

    override fun onStop() {
        settingsDialog?.dismiss()
        invalidatePendingImages()
        work?.cancel(); work = null
        commandEpoch++; commandBusy = false
        healthy = false
        resetReceiver()
        super.onStop()
    }

    override fun onDestroy() { images.evictAll(); super.onDestroy() }
    override fun onResume() { super.onResume(); MirrorImmersive.apply(window) }
    override fun onWindowFocusChanged(hasFocus: Boolean) { super.onWindowFocusChanged(hasFocus); if (hasFocus) MirrorImmersive.apply(window) }

    private suspend fun pollBinding() {
        while (currentCoroutineContext().isActive) {
            try {
                val binding = api.connectTerminal(cameraCapable = false)
                val incoming = binding.string("mirrorId").ifBlank { null }
                if (incoming != mirrorId) {
                    resetReceiver(); mirrorId = incoming; state = null; provider = null
                    images.evictAll(); commandEpoch++; commandJob?.cancel(); commandBusy = false
                }
                bindingCode = binding.string("code")
                render()
            } catch (cancel: CancellationException) { throw cancel }
            catch (_: Exception) { healthy = false; render() }
            delay(3_000)
        }
    }

    private suspend fun pollState() {
        var providerAt = 0L
        while (currentCoroutineContext().isActive) {
            val id = mirrorId
            if (id == null) { delay(200); continue }
            try {
                val fresh = state?.let { api.changes(id, it.optLong("revision")) } ?: api.state(id)
                if (id != mirrorId) continue
                adoptState(fresh)
                val now = SystemClock.elapsedRealtime()
                if (provider == null || now - providerAt > 10_000) {
                    val value = api.liveStatus(id)
                    if (id != mirrorId) continue
                    provider = value; providerAt = now
                }
                if (error == backendError) error = ""
                backendError = ""
                healthy = true; render()
            } catch (cancel: CancellationException) { throw cancel }
            catch (cause: Exception) {
                healthy = false
                backendError = (cause as? ExhibitionApiException)?.message.orEmpty()
                if (backendError.isNotEmpty()) error = backendError
                render(); delay(1_000)
            }
            delay(100)
        }
    }

    private suspend fun pollVideo() {
        var lastSuccess = SystemClock.elapsedRealtime()
        while (currentCoroutineContext().isActive) {
            val id = mirrorId
            if (id == null) { delay(200); continue }
            val requestReceiver = receiverId
            try {
                val result = api.pollComputerDisplay(id, requestReceiver, sessionId, signalCursor)
                if (id != mirrorId || requestReceiver != receiverId) continue
                val session = result.optJSONObject("session")
                val incoming = session?.string("id")?.ifBlank { null }
                if (incoming != sessionId) {
                    resetReceiver()
                    if (incoming != null) {
                        sessionId = incoming
                        computerDeviceId = requireNotNull(session).string("deviceId")
                        attachReceiver(id, incoming, requestReceiver)
                    }
                }
                if (incoming != null) {
                    val messages = result.optJSONArray("messages") ?: JSONArray()
                    for (at in 0 until messages.length()) {
                        val message = messages.optJSONObject(at) ?: continue
                        val payload = message.optJSONObject("payload") ?: continue
                        val kind = message.string("kind")
                        val epoch = payload.optLong("epoch", -1)
                        if (kind == "offer" && epoch > signalEpoch) {
                            signalEpoch = epoch; videoReady = false; error = ""
                            computerPresentation = NativeComputerPresentation.from()
                            clearPageReceipt()
                            receiver?.setPagePresentation(false)
                        }
                        if (kind == "candidate" && epoch >= signalEpoch) {
                            receiver?.receive(kind, payload)
                            continue
                        }
                        if (epoch != signalEpoch) continue
                        when (kind) {
                            "offer", "candidate" -> receiver?.receive(kind, payload)
                            "presentation" -> {
                                val nextPresentation = NativeComputerPresentation.from(payload.string("source"),
                                    payload.optBoolean("mirrored", false), payload.optInt("rotation", 0),
                                    payload.optBoolean("active", false),
                                    if (payload.has("presentationId") && !payload.isNull("presentationId"))
                                        payload.optLong("presentationId", -1) else null)
                                if (computerPresentation != nextPresentation) clearPageReceipt()
                                computerPresentation = nextPresentation
                                receiver?.setPagePresentation(computerPresentation.isPage, computerPresentation.active,
                                    computerPresentation.presentationId)
                                receiver?.setRotation(computerPresentation.rotation)
                                receiver?.setMirrored(computerPresentation.mirrored)
                            }
                            "reset" -> {
                                receiver?.reset(); videoReady = false
                                computerPresentation = NativeComputerPresentation.from()
                                clearPageReceipt()
                                receiver?.setPagePresentation(false)
                            }
                        }
                    }
                    signalCursor = result.optLong("cursor", signalCursor)
                }
                lastSuccess = SystemClock.elapsedRealtime()
                render()
            } catch (cancel: CancellationException) { throw cancel }
            catch (_: Exception) {
                if (SystemClock.elapsedRealtime() - lastSuccess > 8_000 && requestReceiver == receiverId) {
                    resetReceiver(); receiverId = UUID.randomUUID().toString()
                    error = "电脑连接中断，正在重连"; render()
                }
                delay(1_000)
            }
            delay(if (sessionId == null) 1_000 else 400)
        }
    }

    private fun attachReceiver(id: String, session: String, identity: String) {
        val current = NativeComputerVideoReceiver(this,
            onSignal = { kind, payload ->
                work?.launch {
                    signalLock.withLock {
                        val epoch = payload.optLong("epoch", -1)
                        if (id != mirrorId || session != sessionId || identity != receiverId || epoch != signalEpoch) return@withLock
                        try { api.signalComputerDisplay(id, identity, session, kind, payload) }
                        catch (cancel: CancellationException) { throw cancel }
                        catch (_: Exception) {
                            if (id == mirrorId && session == sessionId && identity == receiverId && epoch == signalEpoch) {
                                error = "视频连接未完成，点状态重试"; render()
                            }
                        }
                    }
                }
            },
            onReady = { ready ->
                if (id == mirrorId && session == sessionId && identity == receiverId) {
                    if (!ready) renderedPageReceipt = null
                    videoReady = ready; if (ready) error = ""; render()
                }
            },
            onError = { message -> if (id == mirrorId && session == sessionId && identity == receiverId) {
                videoReady = false; error = message; render()
            } },
            onPageRendered = { epoch, presentationId ->
                if (id == mirrorId && session == sessionId && identity == receiverId && epoch == signalEpoch) {
                    renderedPageReceipt = PageReceipt(session, identity, epoch, presentationId)
                    render()
                }
            })
        receiver = current
        kiosk.stage.addView(current.view, 1, FrameLayout.LayoutParams(-1, -1))
    }

    private fun resetReceiver() {
        // Invalidate callbacks before releasing the native peer and render thread.
        sessionId = null; computerDeviceId = ""; signalCursor = 0; signalEpoch = 0
        videoReady = false; computerPresentation = NativeComputerPresentation.from()
        clearPageReceipt()
        val old = receiver; receiver = null
        old?.close(); old?.view?.let { (it.parent as? ViewGroup)?.removeView(it) }
    }

    private fun command(action: String, lookId: String? = null) {
        if (computerPresentation.isPage) return // The Mac owns all page interactions.
        val id = mirrorId ?: return
        val snapshot = state ?: return
        val stopping = action in listOf("end", "idle")
        if (!healthy || (commandBusy && !stopping)) return
        if (!stopping && action in listOf("begin", "resume", "recover") && ((!videoReady && !imageSource) || sessionId == null)) return
        if (stopping) commandJob?.cancel()
        val epoch = ++commandEpoch
        commandBusy = true; error = ""; render()
        commandJob = work?.launch {
            try {
                val updated = api.command(id, action, snapshot.optLong("revision"), lookId)
                if (id == mirrorId && epoch == commandEpoch) adoptState(updated)
            } catch (cancel: CancellationException) { throw cancel }
            catch (cause: Exception) { if (epoch == commandEpoch) error = (cause as? ExhibitionApiException)?.message ?: "操作未完成，请重试" }
            finally { if (epoch == commandEpoch) { commandBusy = false; render() } }
        }
    }

    private fun startOrStop() {
        val current = state ?: return
        if (current.string("phase") == "paused") {
            if (!commandBusy && current.optJSONObject("live") == null) command("resume")
            return
        }
        command(when {
            current.optJSONObject("live")?.optBoolean("localEnded") == true -> "recover"
            commandBusy || current.optJSONObject("live") != null || current.string("phase") in listOf("generating", "showcase", "positioning") -> "end"
            else -> "begin"
        })
    }

    private fun render() {
        if (!::kiosk.isInitialized || isDestroyed) return
        val pageSource = computerPresentation.isPage
        receiver?.view?.let { video ->
            val target = if (pageSource) pageLayer else kiosk.stage
            if (video.parent !== target) {
                (video.parent as? ViewGroup)?.removeView(video)
                target.addView(video, if (pageSource) 0 else 1, FrameLayout.LayoutParams(-1, -1))
            }
        }
        // Keep the receiver surface alive underneath the opaque connection UI while waiting
        // for its first rendered frame; GONE would prevent that first frame from being drawn.
        pageLayer.visibility = if (pageSource) View.VISIBLE else View.GONE
        val pageVisible = computerPresentation.showFullPage(sessionId != null, videoReady, healthy)
        kiosk.visibility = if (pageVisible) View.GONE else View.VISIBLE
        if (pageVisible) pageLayer.postOnAnimation {
            // Run after the next traversal removed the native overlay from the window.
            pageLayer.post { acknowledgeRenderedPage() }
        }
        val snapshot = state
        val live = snapshot?.optJSONObject("live")
        val phase = snapshot?.string("phase").orEmpty()
        val displayError = error.takeUnless { phase == "paused" && it == "本次换装已结束，请由工作人员继续体验。" }.orEmpty()
        val mode = snapshot?.string("experienceMode").orEmpty()
        val bound = mirrorId != null
        val selected = NativeMaterialCatalog.selected(snapshot)
        val available = sessionId != null && (videoReady || imageSource)
        val presentation = NativeMirrorUiState.resolve(true, imageSource, available, false, phase,
            commandBusy, false, live != null, live?.optBoolean("localEnded") == true)
        kiosk.pairing.visibility = if (bound) View.GONE else View.VISIBLE
        kiosk.pairCode.text = bindingCode.ifBlank { "····" }
        kiosk.poster.visibility = if (!available || imageSource) View.VISIBLE else View.GONE
        if (kiosk.poster.visibility == View.VISIBLE) {
            val image = if (imageSource && mode == "mox") selected?.string("referenceImage")?.ifBlank { selected.string("image") }
                else selected?.string("image")
            bindImage(kiosk.poster, image, 1920)
        }
        kiosk.empty.text = snapshot?.optJSONObject("catalog")?.string("emptyMessage").orEmpty().ifBlank { "暂无可用素材" }
        kiosk.empty.visibility = if (bound && selected == null) View.VISIBLE else View.GONE
        kiosk.status.text = when {
            displayError.isNotEmpty() -> displayError
            !bound -> "待绑定"
            !healthy -> "连接后台…"
            sessionId == null -> "等待电脑视频源"
            !available -> "连接电脑画面…"
            live?.optBoolean("localEnded") == true -> "云端状态待确认"
            phase != "paused" && (snapshot?.optJSONObject("lifecycle")?.optLong("idleEndsAt", 0) ?: 0) > 0 -> "即将返回待机，点此继续体验"
            else -> ""
        }
        kiosk.status.visibility = if (kiosk.status.text.isEmpty()) View.GONE else View.VISIBLE
        val settings = snapshot?.optJSONObject("settings")
        val custom = settings?.optJSONObject("uiSkin")?.string("image").orEmpty()
        kiosk.applySkin(settings?.string("uiSkinPreset").orEmpty().ifBlank { "crystal" }, custom.isNotBlank())
        if (custom.isNotBlank()) bindImage(kiosk.skin, custom, 1920)
        kiosk.primary.text = when {
            pageSource -> "等待无线投屏…"
            sessionId == null && !presentation.stopIcon -> "等待电脑…"
            else -> presentation.primaryText
        }
        kiosk.setPrimaryIcon(presentation.stopIcon, presentation.recoverIcon)
        kiosk.primary.visibility = if (bound && !presentation.showFooterStop) View.VISIBLE else View.GONE
        kiosk.stopButton.visibility = if (bound && presentation.showFooterStop) View.VISIBLE else View.GONE
        kiosk.stopButton.contentDescription = presentation.primaryText
        val active = live != null || phase in listOf("generating", "showcase", "positioning", "paused") || commandBusy
        val configured = snapshot?.string("providerMode") != "xmax" || provider?.optBoolean("configured") == true
        kiosk.primary.isEnabled = !pageSource && bound && healthy && if (phase == "paused")
            live == null && !commandBusy && available && selected != null && configured
            else active || (available && selected != null && configured)
        kiosk.stopButton.isEnabled = kiosk.primary.isEnabled
        kiosk.continueButton.visibility = if (bound && presentation.showContinue) View.VISIBLE else View.GONE
        kiosk.continueButton.isEnabled = !pageSource && healthy && available && !commandBusy
        kiosk.home.visibility = if (bound && phase !in listOf("idle", "select", "paused", "")) View.VISIBLE else View.GONE
        kiosk.home.isEnabled = !pageSource && healthy
        kiosk.gestures.visibility = View.GONE
        if (pageSource || !bound || lastMode != mode || phase == "paused") kiosk.drawer.setOpen(false)
        lastMode = mode
        kiosk.drawer.visibility = if (!pageSource && bound && selected != null) View.VISIBLE else View.GONE
        kiosk.drawer.submit(looks(snapshot), snapshot?.string("selectedLookId").orEmpty(),
            settings?.optInt("materialDrawerColumns", 2) ?: 2,
            healthy && !commandBusy && phase in listOf("idle", "select", "generating", "showcase") && sessionId != null && (live == null || live.string("deviceId") == computerDeviceId),
            if (mode == "clothx") "选择服装" else "选择素材")
    }

    private fun showSettings() {
        if (settingsDialog != null) return
        val content = NativeDeviceSettingsView(this)
        content.address.setText(screenUrl)
        content.backendIp.setText(prefs.getString("backend-ip", ""))
        val source = Spinner(this).apply {
            contentDescription = "视频来源"
            adapter = ArrayAdapter(this@NativeComputerDisplayActivity, android.R.layout.simple_spinner_item,
                arrayOf("安卓摄像头", "局域网电脑")).also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
            setSelection(1)
            isEnabled = canChangeSettings()
        }
        content.cameraContainer.addView(MirrorSettingsStyle.label(this).apply { text = "视频来源" })
        content.cameraContainer.addView(source, LinearLayout.LayoutParams(-1, MirrorUiTheme.dp(this, 48f)))
        content.meta.text = "原生版 ${BuildConfig.VERSION_NAME} · ${Build.MODEL}"
        val dialog = MirrorSettingsDialog(this, content)
        settingsDialog = dialog
        dialog.setOnDismissListener { settingsDialog = null; MirrorImmersive.apply(window) }
        content.cancelButton.setOnClickListener { dialog.dismiss() }
        content.saveButton.setOnClickListener {
            try {
                val url = UrlPolicy.cameraScreenUrl(content.address.text.toString())
                val ip = content.backendIp.text.toString().trim()
                if (ip.isNotEmpty()) LanBackendAddress.requirePrivateIpv4(ip)
                ExhibitionApi(url, terminalId, terminalToken, Build.MODEL)
                val changed = source.selectedItemPosition != 1 || url != screenUrl || ip != prefs.getString("backend-ip", "")
                if (!changed) { dialog.dismiss(); return@setOnClickListener }
                // A computer or staff command may have started an experience since this dialog opened.
                if (!canChangeSettings()) {
                    Toast.makeText(this, "请先结束当前体验", Toast.LENGTH_SHORT).show()
                    return@setOnClickListener
                }
                check(prefs.edit().putString("screen-url", url).putString("backend-ip", ip)
                    .putString("native-video-source", if (source.selectedItemPosition == 0) "android" else "computer").commit())
                dialog.dismiss(); startActivity(Intent(this, MainActivity::class.java)); finish()
            } catch (cause: IllegalArgumentException) { content.address.error = cause.message }
            catch (_: Exception) { Toast.makeText(this, "设置未保存，请重试", Toast.LENGTH_SHORT).show() }
        }
        dialog.show()
    }

    private fun clearPageReceipt() {
        renderedPageReceipt = null; sentPageReceipt = null; sendingPageReceipt = null
    }

    /** Confirm the complete page only after EGL drew it and render() hid native chrome. */
    private fun acknowledgeRenderedPage() {
        val id = mirrorId ?: return
        val receipt = renderedPageReceipt ?: return
        fun current() = id == mirrorId && receipt.session == sessionId && receipt.receiver == receiverId &&
            receipt.epoch == signalEpoch && computerPresentation.isPage && computerPresentation.active &&
            computerPresentation.presentationId == receipt.presentationId &&
            computerPresentation.showFullPage(sessionId != null, videoReady, healthy) && kiosk.visibility == View.GONE
        if (!current() || receipt == sentPageReceipt || receipt == sendingPageReceipt) return
        sendingPageReceipt = receipt
        work?.launch {
            try {
                signalLock.withLock {
                    if (!current()) return@withLock
                    api.signalComputerDisplay(id, receipt.receiver, receipt.session, "rendered",
                        JSONObject().put("epoch", receipt.epoch).put("presentationId", receipt.presentationId))
                    if (current()) sentPageReceipt = receipt
                }
            } catch (cancel: CancellationException) { throw cancel }
            catch (_: Exception) { /* Retry on the next state poll without claiming success. */ }
            finally { if (sendingPageReceipt == receipt) sendingPageReceipt = null }
        } ?: run { sendingPageReceipt = null }
    }

    private fun canChangeSettings() = !commandBusy && state?.optJSONObject("live") == null &&
        (mirrorId == null || state?.string("phase") in listOf("idle", "select"))

    private fun invalidatePendingImages() {
        pendingImages.keys.forEach { it.tag = null }
        pendingImages.clear()
    }

    private fun bindImage(target: ImageView, path: String?, maxSide: Int) {
        val key = if (path.isNullOrBlank()) "" else "$maxSide|$path"
        if (target.tag == key) return
        target.tag = key; target.setImageDrawable(null)
        if (key.isEmpty()) return
        images.get(key)?.let { target.setImageBitmap(it); return }
        val request = Any()
        pendingImages[target] = request
        work?.launch {
            try {
                val bitmap = imageSlots.withPermit {
                    val bytes = api.image(path!!)
                    withContext(Dispatchers.Default) {
                        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                        var sample = 1
                        while (max(bounds.outWidth, bounds.outHeight) / sample > maxSide) sample *= 2
                        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
                    }
                }
                if (bitmap != null) {
                    images.put(key, bitmap)
                    if (pendingImages[target] === request && target.tag == key) target.setImageBitmap(bitmap)
                } else if (pendingImages[target] === request && target.tag == key) target.tag = null
            } catch (cancel: CancellationException) {
                if (pendingImages[target] === request && target.tag == key) target.tag = null
                throw cancel
            } catch (_: Exception) {
                if (pendingImages[target] === request && target.tag == key) target.tag = null
            } finally {
                if (pendingImages[target] === request) pendingImages.remove(target)
            }
        } ?: run { pendingImages.remove(target); target.tag = null }
    }

    private fun adoptState(incoming: JSONObject) {
        NativeMaterialCatalog.requireCurrent(incoming)
        if (incoming.optLong("revision", -1) >= (state?.optLong("revision", -1) ?: -1)) state = incoming
    }

    private fun looks(value: JSONObject?): List<JSONObject> = NativeMaterialCatalog.looks(value)

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (computerPresentation.isPage) return super.dispatchKeyEvent(event)
        val direction = when (event.keyCode) {
            KeyEvent.KEYCODE_PAGE_UP, KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_UP -> -1
            KeyEvent.KEYCODE_PAGE_DOWN, KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_DOWN -> 1
            else -> return super.dispatchKeyEvent(event)
        }
        if (settingsDialog != null || event.isAltPressed || event.isCtrlPressed || event.isMetaPressed || event.isShiftPressed) return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0 && healthy && !commandBusy && sessionId != null) {
            NativeMaterialCatalog.next(state, direction)?.let { next ->
                command(if (state?.string("phase") in listOf("generating", "showcase")) "switch" else "select", next.string("id"))
            }
        }
        return true
    }

    @Deprecated("Android legacy back callback")
    override fun onBackPressed() {
        if (computerPresentation.isPage) { showSettings(); return }
        if (kiosk.drawer.isOpen) { kiosk.drawer.setOpen(false); return }
        if (state?.optJSONObject("live") != null) command("end") else super.onBackPressed()
    }

    private fun JSONObject.string(key: String) = if (isNull(key)) "" else optString(key, "")
}
