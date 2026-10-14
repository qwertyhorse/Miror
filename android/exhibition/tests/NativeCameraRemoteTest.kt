package ai.openbuy.exhibition

import org.json.JSONObject
import java.time.Instant

/** Remote detection can only open on the exact terminal binding; payloads never contain frames. */
fun main() {
    var assertions = 0
    fun verify(condition: Boolean, message: String) { check(condition) { message }; assertions++ }
    val now = Instant.parse("2026-10-14T10:00:00Z").toEpochMilli()
    fun request(id: String = "req-1", mirror: String = "mirror-a", terminal: String = "terminal-a",
                binding: String = "binding-a", expires: Long = now + 120_000) = JSONObject()
        .put("id", id).put("action", "open").put("mirrorId", mirror).put("terminalId", terminal)
        .put("bindingId", binding).put("expiresAt", expires)
    val remote = NativeCameraRemote()
    verify(remote.report(now) == null, "Unbound terminal cannot send camera metadata")
    verify(remote.bind("mirror-a", null), "Older server can bind a terminal without camera support")
    verify(remote.report(now) == null, "Missing binding epoch never uploads a report")
    verify(remote.bind("mirror-a", "binding-a"), "Camera capability obtains a binding epoch")
    verify(!remote.bind("mirror-a", "binding-a"), "Repeated poll does not reset camera state")
    verify(remote.consume(null, "terminal-a", now, false) == null, "No request has no effect")
    verify(remote.consume(request(mirror = "mirror-b"), "terminal-a", now, false) == null, "Different mirror cannot open camera")
    verify(remote.consume(request(terminal = "terminal-b"), "terminal-a", now, false) == null, "Different terminal cannot open camera")
    verify(remote.consume(request(binding = "binding-old"), "terminal-a", now, false) == null, "Old binding cannot open camera")
    verify(remote.consume(request(expires = now), "terminal-a", now, false) == null, "Request expires at its exact deadline")
    verify(remote.consume(request().put("expiresAt", "invalid"), "terminal-a", now, false) == null, "Malformed deadline fails closed")
    verify(remote.consume(request().put("expiresAt", now.toDouble() + 12.5), "terminal-a", now, false) == null, "Fractional deadline fails closed")
    verify(remote.consume(request().put("expiresAt", (now + 120_000).toString()), "terminal-a", now, false) == null, "Deadline must use numeric milliseconds")
    verify(remote.consume(request().put("action", "capture"), "terminal-a", now, false) == null, "Unknown action cannot capture camera")
    verify(remote.consume(request().put("id", ""), "terminal-a", now, false) == null, "Empty identity fails closed")
    verify(remote.handledRequests().isEmpty(), "Foreign or expired requests cannot poison replay protection")
    val open = checkNotNull(remote.consume(request(), "terminal-a", now, false))
    verify(open.id == "req-1" && remote.owns(open), "Valid request opens the current binding")
    verify(remote.report(now)!!.getString("status") == "scanning", "Accepted request reports scanning")
    verify(remote.report(now)!!.getString("requestId") == "req-1", "Request acknowledgement carries exact identity")
    verify(remote.consume(request(), "terminal-a", now + 1, false) == null, "Next poll cannot replay an open request")
    val restarted = NativeCameraRemote(remote.handledRequests())
    restarted.bind("mirror-a", "binding-a")
    verify(restarted.consume(request(), "terminal-a", now, false) == null, "Persisted request IDs prevent process-restart replay")

    val external = NativeCameraDevice("usb-42", NativeCameraFacing.EXTERNAL, "USB Camera")
    val snapshot = NativeCameraSnapshot(emptyList(), devices = listOf(external), rtcEnumerated = true)
    remote.update("preview", snapshot, NativeCameraSelection("usb-42"), "usb-42")
    val report = checkNotNull(remote.report(now))
    verify(report.getString("mirrorId") == "mirror-a" && report.getString("bindingId") == "binding-a", "Report is bound to exact mirror and epoch")
    verify(report.getString("selectedDeviceId") == "usb-42" && report.getString("activeDeviceId") == "usb-42", "Saved choice and actual preview are explicit")
    val device = report.getJSONArray("devices").getJSONObject(0)
    verify(device.getString("id") == "usb-42" && device.getString("kind") == "external", "Only RTC-supported exact ID and facing are reported")
    verify(device.keySet() == setOf("id", "kind", "label"), "Device payload contains metadata only")
    verify(report.keySet() == setOf("mirrorId", "bindingId", "requestId", "status", "devices", "selectedDeviceId", "activeDeviceId"), "Report has no preview, frame, credential, or media URL")
    remote.update("closed", snapshot, NativeCameraSelection.Automatic, null)
    val closed = checkNotNull(remote.report(now))
    verify(closed.getString("status") == "closed" && closed.isNull("selectedDeviceId") && closed.isNull("activeDeviceId"), "Cancel/automatic preserves nullable local selection and clears preview")
    remote.update("ready", snapshot, NativeCameraSelection("usb-42"), "usb-42")
    verify(remote.report(now)!!.getString("status") == "closed", "Resumed local preview cannot overwrite pending close acknowledgement")
    verify(remote.consume(request(), "terminal-a", now + 2, false) == null, "Closing does not make a request replayable")
    verify(remote.report(now + 120_000)!!.isNull("requestId"), "Expired request is no longer sent as an acknowledgement")

    verify(remote.consume(request("req-busy"), "terminal-a", now, true) == null, "Active experience cannot open settings or interrupt generation")
    val busy = checkNotNull(remote.report(now))
    verify(busy.getString("status") == "busy" && busy.getString("requestId") == "req-busy", "Busy response acknowledges only the rejected request")
    remote.update("ready", snapshot, NativeCameraSelection("usb-42"), "usb-42")
    verify(remote.report(now)!!.getString("status") == "busy", "Routine camera update cannot overwrite a pending busy acknowledgement")
    remote.acknowledge(JSONObject(busy.toString()).put("bindingId", "other-binding"))
    remote.update("preview", snapshot, NativeCameraSelection("usb-42"), "usb-42")
    verify(remote.report(now)!!.getString("status") == "busy", "Foreign acknowledgement cannot release pending result")
    remote.acknowledge(busy)
    remote.update("ready", snapshot, NativeCameraSelection("usb-42"), "usb-42")
    verify(remote.report(now)!!.getString("status") == "ready" && remote.report(now)!!.isNull("requestId"), "Accepted terminal result releases request scope for ordinary metadata")
    verify(remote.consume(request("req-busy"), "terminal-a", now, false) == null, "Busy request does not reopen later when experience ends")
    verify(remote.consume(request("req-retry"), "terminal-a", now, false) != null, "A fresh explicit request can retry after busy")
    for (status in NativeCameraRemote.STATUSES) {
        remote.consume(request("status-$status"), "terminal-a", now, false)
        remote.update(status, snapshot, NativeCameraSelection.Automatic, null, "error".repeat(80))
        verify(remote.report(now)!!.getString("status") == status, "Reports $status")
        verify(remote.report(now)!!.getString("error").length == 200, "Bounded error message for $status")
    }
    try { remote.update("unexpected", snapshot, NativeCameraSelection.Automatic, null); error("Accepted unknown status") }
    catch (_: IllegalArgumentException) { assertions++ }
    verify(remote.bind("mirror-b", "binding-b"), "Rebinding rotates report scope")
    val rebound = checkNotNull(remote.report(now))
    verify(rebound.getJSONArray("devices").length() == 0 && rebound.isNull("requestId") && rebound.isNull("selectedDeviceId")
        && rebound.isNull("activeDeviceId") && !rebound.has("error"), "Rebinding clears prior mirror metadata, error, selected IDs, and request")
    verify(!remote.owns(open), "Old dialog loses reporting ownership after rebind")
    verify(remote.consume(request(), "terminal-a", now, false) == null, "Delayed old response cannot open on new binding")
    remote.bind(null, null)
    verify(remote.report(now) == null, "Unbinding stops all reports")
    remote.bind("mirror-a", "binding-c")
    verify(remote.consume(request(binding = "binding-c"), "terminal-a", now, false) != null, "Fresh binding can accept a fresh request scope")
    repeat(80) { remote.consume(request("bounded-$it", binding = "binding-c"), "terminal-a", now, false) }
    verify(remote.handledRequests().size == 64, "Replay history is bounded")
    println("Native camera remote tests passed ($assertions assertions); metadata only, no hardware or cloud calls.")
}
