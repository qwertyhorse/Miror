package ai.openbuy.exhibition

import android.content.Context
import android.graphics.Color
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import ai.xmax.sdk.XmaxRealtimeVideoView
import kotlinx.coroutines.*

/** An exclusive, local-only camera lease. Preferences are committed by the dialog's Save action. */
internal class NativeCameraSettingsPanel(
    context: Context,
    private val controller: NativeXmaxController,
    initialSelection: NativeCameraSelection,
    private val legacyPosition: String?,
    private val migrateLegacy: Boolean,
    private val awaitExclusive: suspend () -> Unit,
    private val requestPermission: () -> Boolean,
) : LinearLayout(context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var operation: Job? = null
    private var epoch = 0L
    private var closed = false
    private var initialized = false
    private var options = listOf<String?>(null)
    private val spinner = Spinner(context)
    private val refresh = Button(context).apply { text = "重新检测"; isAllCaps = false }
    private val feedback = TextView(context).apply { textSize = 13f; setPadding(0, dp(6), 0, dp(6)) }
    private val preview = XmaxRealtimeVideoView(context).apply {
        setBackgroundColor(Color.BLACK)
        visibility = View.GONE
    }
    var selection = initialSelection
        private set
    private var snapshot = NativeCameraSnapshot(emptyList())

    init {
        orientation = VERTICAL
        addView(TextView(context).apply { text = "摄像头"; textSize = 13f })
        addView(LinearLayout(context).apply {
            orientation = HORIZONTAL
            addView(spinner, LayoutParams(0, dp(48), 1f))
            addView(refresh, LayoutParams(-2, dp(48)))
        })
        addView(feedback, LayoutParams(-1, -2))
        addView(preview, LayoutParams(-1, dp(180)))
        spinner.contentDescription = "选择摄像头"
        spinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (!initialized || position !in options.indices || options[position] == selection.cameraId) return
                selection = NativeCameraSelection(options[position])
                launchOperation { showPreview() }
            }
        }
        refresh.setOnClickListener { rescan() }
        rescan()
    }

    fun rescan() {
        if (closed) return
        if (!requestPermission()) {
            message("请允许摄像头权限", true)
            return
        }
        launchOperation {
            message("检测中…")
            snapshot = controller.detectCameras()
            if (!initialized && migrateLegacy) {
                selection = NativeCameraSelection.migrate(null, legacyPosition, snapshot.devices)
            }
            val ids = mutableListOf<String?>(null)
            val labels = mutableListOf("自动选择")
            snapshot.devices.forEach { ids.add(it.id); labels.add(it.label) }
            if (selection.cameraId != null && selection.cameraId !in ids) {
                ids.add(selection.cameraId)
                labels.add("摄像头 ${selection.cameraId}（未连接）")
            }
            options = ids
            spinner.adapter = ArrayAdapter(context, android.R.layout.simple_spinner_item, labels).apply {
                setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
            }
            spinner.setSelection(ids.indexOf(selection.cameraId).coerceAtLeast(0))
            initialized = true
            showPreview()
        }
    }

    private suspend fun showPreview() {
        val selected = selection.resolve(snapshot.devices)
        if (selected == null) {
            preview.visibility = View.GONE
            message(selection.unavailableMessage(snapshot), true)
            return
        }
        message("连接摄像头…")
        preview.visibility = View.VISIBLE
        val owner = epoch
        controller.onError = {
            if (!closed && owner == epoch) message("摄像头已断开，请重新检测", true)
        }
        controller.preview(cameraDeviceId = selected.id, target = preview)
        if (!closed && owner == epoch) message("已连接 · ${selected.label}")
    }

    private fun launchOperation(action: suspend () -> Unit) {
        val owner = ++epoch
        val previous = operation
        previous?.cancel()
        operation = scope.launch {
            try {
                previous?.join()
                awaitExclusive()
                ensureActive()
                controller.onError = null
                controller.disconnect()
                action()
            } catch (cancel: CancellationException) { throw cancel }
            catch (_: Exception) {
                if (!closed && owner == epoch) {
                    preview.visibility = View.GONE
                    message(if (controller.hasReleaseFailure) "摄像头释放失败，请重新打开应用" else "摄像头不可用，请重新检测", true)
                }
            }
        }
    }

    suspend fun close() {
        if (closed) return
        closed = true
        epoch++
        try {
            operation?.cancelAndJoin()
            // No other engine may resume until this has completed, including on Activity.onStop.
            withContext(NonCancellable) {
                awaitExclusive()
                controller.onError = null
                controller.disconnect()
            }
        } finally { scope.cancel() }
    }

    private fun message(text: String, failed: Boolean = false) {
        feedback.text = text
        feedback.setTextColor(if (failed) Color.rgb(175, 60, 65) else Color.rgb(113, 104, 137))
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density + .5f).toInt()
}
