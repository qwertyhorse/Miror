package ai.openbuy.exhibition

import android.content.Context
import android.graphics.Color
import android.view.View
import android.widget.AdapterView
import android.widget.FrameLayout
import ai.xmax.sdk.VideoContentMode
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
    initialRotationDegrees: Int = 0,
    private val onState: (String, NativeCameraSnapshot, NativeCameraSelection, String?, String?) -> Unit = { _, _, _, _, _ -> },
    initialCaptureSelection: NativeCameraCaptureSelection = NativeCameraCaptureSelection.Automatic,
) : NativeCameraSettingsView(context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var operation: Job? = null
    private var epoch = 0L
    private var closed = false
    private var initialized = false
    private var options = listOf<String?>(null)
    private var captureOptions = listOf(NativeCameraCaptureSelection.Automatic)
    private var unavailableCapturePosition: Int? = null
    private var updatingCaptureChoices = false
    private val preview = XmaxRealtimeVideoView(context).apply {
        setBackgroundColor(Color.BLACK)
        videoContentMode = VideoContentMode.FIT
        visibility = View.GONE
    }
    var selection = initialSelection
        private set
    var rotationDegrees = initialRotationDegrees
        private set
    var captureSelection = initialCaptureSelection
        private set
    private var snapshot = NativeCameraSnapshot(emptyList())
    private var previewedDeviceId: String? = null

    val hasVerifiedPreview: Boolean
        get() = !closed && !controller.hasReleaseFailure && previewedDeviceId != null &&
            selection.resolve(snapshot.devices)?.id == previewedDeviceId

    init {
        require(initialRotationDegrees in listOf(0, 90, 180, 270))
        rotationSpinner.setSelection(initialRotationDegrees / 90)
        rotationSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (position !in 0..3 || position * 90 == rotationDegrees) return
                rotationDegrees = position * 90
                if (initialized) launchOperation { showPreview() }
            }
        }
        previewContainer.addView(preview, FrameLayout.LayoutParams(-1, -1))
        captureSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (!initialized || updatingCaptureChoices || position !in captureOptions.indices ||
                    position == unavailableCapturePosition || captureOptions[position] == captureSelection) return
                captureSelection = captureOptions[position]
                launchOperation { showPreview() }
            }
        }
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
        previewedDeviceId = null
        if (!requestPermission()) {
            message("请允许摄像头权限", true)
            report("permission-required", "请允许摄像头权限")
            return
        }
        launchOperation {
            message("检测中…")
            report("scanning")
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
            setChoices(labels)
            spinner.setSelection(ids.indexOf(selection.cameraId).coerceAtLeast(0))
            initialized = true
            showPreview()
        }
    }

    private suspend fun showPreview() {
        val selected = selection.resolve(snapshot.devices)
        updateCaptureChoices(selected)
        if (selected == null) {
            preview.visibility = View.GONE
            previewContainer.visibility = View.GONE
            message(selection.unavailableMessage(snapshot), true)
            report("ready", selection.unavailableMessage(snapshot))
            return
        }
        try {
            captureSelection.resolve(selected)
        } catch (error: IllegalArgumentException) {
            preview.visibility = View.GONE
            previewContainer.visibility = View.GONE
            message(checkNotNull(error.message), true)
            report("ready", error.message)
            return
        }
        message("连接摄像头…")
        report("scanning")
        preview.visibility = View.VISIBLE
        previewContainer.visibility = View.VISIBLE
        val owner = epoch
        controller.onError = {
            if (!closed && owner == epoch) {
                previewedDeviceId = null
                message("摄像头已断开，请重新检测", true)
                report("ready", "摄像头已断开，请重新检测")
            }
        }
        controller.preview(cameraDeviceId = selected.id, target = preview, cameraRotationDegrees = rotationDegrees,
            captureSelection = captureSelection)
        // The shared controller defaults to the full-screen mirror's fill mode.
        preview.videoContentMode = VideoContentMode.FIT
        if (!closed && owner == epoch) {
            previewedDeviceId = selected.id
            val actual = controller.captureInfo
            val requested = captureSelection.size
            val sizeMessage = actual?.let {
                "实际 ${it.width}×${it.height}" + if (requested != null &&
                    (requested.width != it.width || requested.height != it.height))
                    "（请求 ${requested.width}×${requested.height}）" else ""
            }
            message(sizeMessage ?: "已连接 · ${selected.label}")
            report("preview")
        }
    }

    private fun updateCaptureChoices(device: NativeCameraDevice?) {
        val available = device?.let { NativeCameraCaptureSelection.options(it) }.orEmpty()
            .map(::NativeCameraCaptureSelection)
        val nextOptions = listOf(NativeCameraCaptureSelection.Automatic) + available
        val missing = captureSelection.takeUnless { it in nextOptions }
        captureOptions = nextOptions + listOfNotNull(missing)
        unavailableCapturePosition = missing?.let { captureOptions.lastIndex }
        updatingCaptureChoices = true
        try {
            setCaptureChoices(captureOptions.mapIndexed { index, option ->
                option.label + if (index == unavailableCapturePosition) "（不可用）" else ""
            }, unavailableCapturePosition)
            captureSpinner.setSelection(captureOptions.indexOf(captureSelection))
        } finally { updatingCaptureChoices = false }
    }

    private fun launchOperation(action: suspend () -> Unit) {
        val owner = ++epoch
        previewedDeviceId = null
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
                    previewContainer.visibility = View.GONE
                    val failure = if (controller.hasReleaseFailure) "摄像头释放失败，请重新打开应用" else "摄像头不可用，请重新检测"
                    message(failure, true)
                    report(if (controller.hasReleaseFailure) "error" else "ready", failure)
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
        showMessage(text, failed)
    }
    private fun report(status: String, error: String? = null) {
        if (!closed) onState(status, snapshot, selection, previewedDeviceId, error)
    }
}
