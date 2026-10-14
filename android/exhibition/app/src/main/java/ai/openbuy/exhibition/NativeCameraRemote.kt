package ai.openbuy.exhibition

import org.json.JSONArray
import org.json.JSONObject

internal data class NativeCameraOpenRequest(
    val id: String,
    val mirrorId: String,
    val terminalId: String,
    val bindingId: String,
    val expiresAt: Long,
)

/** Metadata only. Binding epochs prevent a camera report or command from crossing mirror ownership. */
internal class NativeCameraRemote(handledRequests: Set<String> = emptySet()) {
    private var mirrorId: String? = null
    private var bindingId: String? = null
    private val handled = LinkedHashSet(handledRequests)
    private var request: NativeCameraOpenRequest? = null
    private var status = "ready"
    private var devices = emptyList<NativeCameraDevice>()
    private var selectedId: String? = null
    private var activeId: String? = null
    private var error: String? = null
    private var terminalStatusPending = false

    fun bind(nextMirrorId: String?, nextBindingId: String?): Boolean {
        val nextBinding = nextBindingId?.takeIf { it.isNotBlank() && nextMirrorId != null }
        if (mirrorId == nextMirrorId && bindingId == nextBinding) return false
        mirrorId = nextMirrorId
        bindingId = nextBinding
        request = null
        status = "ready"
        devices = emptyList()
        selectedId = null
        activeId = null
        error = null
        terminalStatusPending = false
        return true
    }

    fun owns(value: NativeCameraOpenRequest): Boolean = value.mirrorId == mirrorId && value.bindingId == bindingId
    fun bindingKey(): String? = bindingId?.let { "$mirrorId:$it" }
    fun requestId(): String? = request?.id

    fun consume(value: JSONObject?, terminalId: String, now: Long, busy: Boolean): NativeCameraOpenRequest? {
        if (value == null || value.optString("action") != "open") return null
        val expiryValue = value.opt("expiresAt") as? Number ?: return null
        val expires = expiryValue.toLong()
        if (expiryValue.toDouble() != expires.toDouble()) return null
        val next = NativeCameraOpenRequest(value.optString("id"), value.optString("mirrorId"),
            value.optString("terminalId"), value.optString("bindingId"), expires)
        if (next.id.isBlank() || next.terminalId != terminalId || !owns(next) || expires <= now) return null
        val key = "${next.bindingId}:${next.id}"
        if (!handled.add(key)) return null
        while (handled.size > 64) handled.remove(handled.first())
        request = next
        status = if (busy) "busy" else "scanning"
        error = if (busy) "停止体验后可检测摄像头" else null
        terminalStatusPending = busy
        return next.takeUnless { busy }
    }

    fun handledRequests(): Set<String> = handled.toSet()

    fun update(nextStatus: String, snapshot: NativeCameraSnapshot?, selection: NativeCameraSelection,
               activeDeviceId: String?, message: String? = null) {
        require(nextStatus in STATUSES)
        if (terminalStatusPending && nextStatus !in TERMINAL_STATUSES) return
        status = nextStatus
        if (snapshot != null) devices = snapshot.devices.filter { validId(it.id) }.take(24)
        selectedId = selection.cameraId
        activeId = activeDeviceId
        error = message?.replace(Regex("[\\p{Cntrl}]"), " ")?.trim()?.take(200)?.takeIf { it.isNotBlank() }
        terminalStatusPending = request != null && nextStatus in TERMINAL_STATUSES
    }

    fun acknowledge(submitted: JSONObject?) {
        if (!terminalStatusPending || submitted == null || submitted.optString("mirrorId") != mirrorId ||
            submitted.optString("bindingId") != bindingId || submitted.optString("status") != status ||
            submitted.opt("requestId") != (request?.id ?: JSONObject.NULL)) return
        request = null
        terminalStatusPending = false
    }

    fun report(now: Long): JSONObject? {
        val currentMirror = mirrorId ?: return null
        val currentBinding = bindingId ?: return null
        if (selectedId?.let { !validId(it) } == true || activeId?.let { !validId(it) } == true) return null
        if (request?.expiresAt?.let { it <= now } == true) request = null
        return JSONObject().put("mirrorId", currentMirror).put("bindingId", currentBinding)
            .put("requestId", request?.id ?: JSONObject.NULL).put("status", status)
            .put("selectedDeviceId", selectedId ?: JSONObject.NULL)
            .put("activeDeviceId", activeId ?: JSONObject.NULL)
            .put("devices", JSONArray().apply {
                devices.forEach { device -> put(JSONObject().put("id", device.id)
                    .put("label", device.label.replace(Regex("[\\p{Cntrl}]"), " ").trim().take(120).ifBlank { "摄像头" })
                    .put("kind", device.facing.name.lowercase())) }
            }).apply { error?.let { put("error", it) } }
    }

    companion object {
        val STATUSES = setOf("ready", "scanning", "preview", "error", "permission-required", "busy", "closed")
        private val TERMINAL_STATUSES = setOf("busy", "closed", "error")
        private fun validId(value: String) = value.isNotBlank() && value.length <= 512 && value.none { it.isISOControl() }
    }
}
