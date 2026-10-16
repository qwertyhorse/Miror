package ai.openbuy.exhibition

import android.app.Activity
import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import android.widget.ImageView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Screenshot-only entry point, compiled solely into the .uipreview application.
 * It uses production views, never a controller, API client, camera or live session.
 * The capture script supplies unmodified repository images through run-as.
 */
class UiPreviewActivity : Activity() {
    private lateinit var kiosk: MirrorKioskView
    private var dialog: MirrorSettingsDialog? = null
    private var settings: NativeDeviceSettingsView? = null
    private var camera: NativeCameraSettingsView? = null
    private lateinit var scenario: String
    private val fixtureDirectory get() = File(filesDir, "ui-preview")
    private var dialogResult: String? = null
    private var selectedId = ""
    private val materials by lazy {
        val data = File(fixtureDirectory, "materials.json")
        if (data.isFile) JSONArray(data.readText()).let { array ->
            List(array.length()) { array.getJSONObject(it) }
        } else emptyList()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        require(packageName.endsWith(".uipreview")) { "UI fixtures require the isolated application ID" }
        scenario = intent.getStringExtra("scenario") ?: "ready"
        require(scenario in SCENARIOS) { "Unknown UI fixture: $scenario" }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        kiosk = MirrorKioskView(this)
        setContentView(kiosk)
        immersive()
        renderScreen()
        if (scenario.startsWith("settings-") || scenario.startsWith("camera-")) {
            kiosk.post { showSettings(scenario.startsWith("camera-")) }
        }
        kiosk.postDelayed({ writeGeometry() }, 700)
        kiosk.postDelayed({ writeGeometry() }, 1500)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    private fun immersive() {
        MirrorImmersive.apply(window)
    }

    private fun renderScreen() {
        val preset = if (scenario == "crystal") "crystal" else "brand"
        kiosk.applySkin(preset, scenario == "custom")
        if (scenario == "custom") loadImage(kiosk.skin, "custom.png")
        kiosk.empty.visibility = if (scenario == "empty") View.VISIBLE else View.GONE
        kiosk.pairing.visibility = if (scenario == "pairing") View.VISIBLE else View.GONE
        kiosk.pairTitle.text = "设备绑定"
        kiosk.pairCode.text = "2684"
        val waiting = scenario == "waiting"
        val active = scenario in setOf("generating", "stopping", "paused", "idle-countdown")
        val recovering = scenario == "recovering"
        val showMedia = scenario !in setOf("pairing", "empty")
        val presentation = NativeMirrorUiState.resolve(
            realtime = true,
            imageInput = false,
            cameraReady = !waiting && scenario != "error",
            hasRound = active && scenario != "paused",
            phase = if (scenario == "paused") "paused" else if (active) "generating" else "idle",
            actionBusy = false,
            stopBusy = scenario == "stopping",
            hasLive = recovering,
            localEnded = recovering,
        )
        kiosk.poster.visibility = if (showMedia && presentation.showPoster) View.VISIBLE else View.GONE
        materials.firstOrNull()?.optString("image")?.let { loadImage(kiosk.poster, it) }
        kiosk.video.visibility = if (showMedia) View.VISIBLE else View.GONE
        kiosk.video.localPreviewView = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            loadImage(this, if (active || recovering) materials.firstOrNull()?.optString("image").orEmpty() else "camera.png")
        }
        kiosk.primary.text = presentation.primaryText
        kiosk.setPrimaryIcon(presentation.stopIcon, presentation.recoverIcon)
        kiosk.primary.isEnabled = scenario !in setOf("waiting", "error", "stopping", "pairing", "empty")
        kiosk.primary.alpha = if (kiosk.primary.isEnabled) 1f else .65f
        kiosk.primary.visibility = if (scenario == "pairing" || presentation.showFooterStop) View.GONE else View.VISIBLE
        kiosk.stopButton.visibility = if (scenario != "pairing" && presentation.showFooterStop) View.VISIBLE else View.GONE
        kiosk.stopButton.contentDescription = presentation.primaryText
        kiosk.stopButton.isEnabled = kiosk.primary.isEnabled
        kiosk.gestures.text = "手势已开启"
        kiosk.gestures.visibility = if (active) View.VISIBLE else View.GONE
        kiosk.continueButton.visibility = if (presentation.showContinue) View.VISIBLE else View.GONE
        kiosk.home.visibility = if (active || recovering) View.VISIBLE else View.GONE
        kiosk.status.text = when (scenario) {
            "recovering" -> "云端状态待确认"
            "error" -> "摄像头不可用，请重新检测"
            "idle-countdown" -> "即将返回待机，点此继续体验"
            else -> ""
        }
        kiosk.status.visibility = if (kiosk.status.text.isEmpty()) View.GONE else View.VISIBLE
        if (scenario == "error") kiosk.status.setTextColor(Color.rgb(175, 60, 65))
        kiosk.status.setOnClickListener {
            if (scenario == "idle-countdown") {
                kiosk.status.visibility = View.GONE
                writeGeometry()
            }
        }
        selectedId = materials.firstOrNull()?.optString("id").orEmpty()
        kiosk.drawer.bindImage = { target, path -> loadImage(target, path) }
        kiosk.drawer.visibility = if (showMedia) View.VISIBLE else View.GONE
        submitMaterials()
        kiosk.drawer.setOpen(scenario in setOf("drawer-one", "drawer-two"))
        kiosk.drawer.onSelect = { id -> selectedId = id; submitMaterials(); writeGeometry() }
        kiosk.logo.setOnLongClickListener { showSettings(false); true }
    }

    private fun submitMaterials() {
        kiosk.drawer.submit(materials, selectedId, if (scenario == "drawer-one") 1 else 2, true, "选择服装")
    }

    private fun showSettings(remote: Boolean) {
        if (dialog?.isShowing == true) return
        val content = NativeDeviceSettingsView(this, remote)
        val cameraView = NativeCameraSettingsView(this)
        settings = content
        camera = cameraView
        content.address.setText(if (scenario == "settings-long-url")
            "http://xuminghong.local:10601/v1.1/exhibition/control?mirrorId=exhibition-portrait-screen-000001" else
            "http://xuminghong.local:10601/")
        content.backendIp.setText("192.168.1.102")
        content.meta.text = "${BuildConfig.VERSION_NAME} · UI 预览"
        content.cameraContainer.addView(cameraView)
        val unavailable = scenario in setOf("settings-no-camera", "camera-error")
        val scanning = scenario == "camera-scanning"
        val capture4k = NativeCameraCaptureSelection(NativeCameraSize(3840, 2160))
        val capture1080p = NativeCameraCaptureSelection(NativeCameraSize(1920, 1080))
        val selected4k = scenario in setOf("settings-local", "camera-remote")
        cameraView.setChoices(if (unavailable) listOf("自动选择") else listOf("自动选择", "USB 摄像头", "内置前置摄像头"))
        cameraView.setCaptureChoices(when {
            unavailable -> listOf(NativeCameraCaptureSelection.Automatic.label, "${capture4k.label}（不可用）")
            scanning -> listOf(NativeCameraCaptureSelection.Automatic.label)
            else -> listOf(NativeCameraCaptureSelection.Automatic.label, capture4k.label, capture1080p.label)
        }, unavailablePosition = if (unavailable) 1 else null)
        cameraView.captureSpinner.setSelection(if (unavailable || selected4k) 1 else 0)
        cameraView.xmaxRotationSpinner.setSelection(if (scenario == "camera-remote") 2 else 0)
        cameraView.showMessage(when {
            unavailable -> "未检测到摄像头，请连接后重新检测"
            scanning -> "检测中…"
            selected4k -> "实际 3840×2160"
            else -> "实际 1920×1080"
        }, unavailable)
        if (!unavailable && !scanning) {
            cameraView.previewContainer.addView(ImageView(this).apply {
                scaleType = ImageView.ScaleType.FIT_CENTER
                loadImage(this, "camera.png")
            }, FrameLayout.LayoutParams(-1, -1))
            cameraView.previewContainer.visibility = View.VISIBLE
        }
        cameraView.refresh.setOnClickListener {
            cameraView.showMessage("未检测到摄像头，请连接后重新检测", true)
            cameraView.previewContainer.visibility = View.GONE
            writeGeometry()
        }
        val nextDialog = MirrorSettingsDialog(this, content)
        dialog = nextDialog
        content.cancelButton.setOnClickListener { dialogResult = "cancelled"; nextDialog.dismiss() }
        content.saveButton.setOnClickListener { dialogResult = "saved"; nextDialog.dismiss() }
        nextDialog.setOnDismissListener { immersive(); kiosk.postDelayed({ writeGeometry() }, 100) }
        nextDialog.show()
        if (scenario == "settings-keyboard") content.address.postDelayed({
            content.address.requestFocus()
            content.address.setSelection(content.address.text.length)
            (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
                .showSoftInput(content.address, InputMethodManager.SHOW_IMPLICIT)
        }, 300)
        content.postDelayed({ writeGeometry() }, 600)
    }

    private fun loadImage(target: ImageView, name: String) {
        if (name.isEmpty() || File(name).name != name) return
        val file = File(fixtureDirectory, name)
        if (file.isFile) target.setImageBitmap(BitmapFactory.decodeFile(file.path))
    }

    private fun writeGeometry() {
        if (!::kiosk.isInitialized || kiosk.width == 0) return
        fun bounds(view: View): JSONObject {
            val position = IntArray(2)
            view.getLocationOnScreen(position)
            return JSONObject().put("x", position[0]).put("y", position[1])
                .put("width", view.width).put("height", view.height)
                .put("visibility", view.visibility).put("shown", view.isShown)
                .put("attached", view.isAttachedToWindow).put("enabled", view.isEnabled)
        }
        val result = JSONObject().put("scenario", scenario).put("package", packageName)
            .put("rendered", true).put("liveServices", false)
            .put("screen", bounds(kiosk)).put("surface", bounds(kiosk.surface))
            .put("stage", bounds(kiosk.stage)).put("logo", bounds(kiosk.logo))
            .put("primary", bounds(kiosk.primary).put("text", kiosk.primary.text).put("alpha", kiosk.primary.alpha))
            .put("stop", bounds(kiosk.stopButton).put("label", kiosk.stopButton.contentDescription))
            .put("gestures", bounds(kiosk.gestures))
            .put("continue", bounds(kiosk.continueButton)).put("drawerOpen", kiosk.drawer.isOpen)
            .put("dialogVisible", dialog?.isShowing == true).put("dialogResult", dialogResult ?: JSONObject.NULL)
        if (dialog?.isShowing == true) settings?.let { content ->
            result.put("dialog", bounds(content)).put("address", bounds(content.address))
                .put("backendIp", bounds(content.backendIp)).put("save", bounds(content.saveButton))
                .put("cancel", bounds(content.cancelButton))
                .put("cameraPreview", bounds(camera!!.previewContainer))
                .put("captureResolution", bounds(camera!!.captureSpinner)
                    .put("selected", camera!!.captureSpinner.selectedItem)
                    .put("options", JSONArray().apply {
                        val spinner = camera!!.captureSpinner
                        for (index in 0 until spinner.count) put(JSONObject()
                            .put("label", spinner.getItemAtPosition(index))
                            .put("enabled", (spinner.adapter as? android.widget.ListAdapter)?.isEnabled(index) ?: true))
                    }))
                .put("xmaxInputDirection", bounds(camera!!.xmaxRotationSpinner)
                    .put("selected", camera!!.xmaxRotationSpinner.selectedItem)
                    .put("options", JSONArray().apply {
                        val spinner = camera!!.xmaxRotationSpinner
                        for (index in 0 until spinner.count) put(spinner.getItemAtPosition(index))
                    }))
                .put("cameraFeedback", camera!!.feedback.text)
        }
        fixtureDirectory.mkdirs()
        File(fixtureDirectory, "snapshot.json").writeText(result.toString(2))
    }

    companion object {
        private val SCENARIOS = setOf("waiting", "ready", "generating", "stopping", "paused", "recovering",
            "idle-countdown", "error", "empty", "drawer-one", "drawer-two", "pairing", "crystal", "custom",
            "settings-local", "settings-no-camera", "settings-long-url", "settings-keyboard",
            "camera-remote", "camera-error", "camera-scanning")
    }
}
