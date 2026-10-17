package ai.openbuy.exhibition

import android.content.Context
import ai.xmax.sdk.CameraPosition
import ai.xmax.sdk.FixtureRealtimeManager
import ai.xmax.sdk.RealtimeCameraDevice
import ai.xmax.sdk.RealtimeModel
import ai.xmax.sdk.VideoContentMode
import ai.xmax.sdk.XmaxClient
import ai.xmax.sdk.XmaxEnvironment
import ai.xmax.sdk.XmaxRealtimeVideoView
import kotlinx.coroutines.runBlocking

/** Runs the real controller's preview/connect paths through the SDK call boundary. */
fun main() = runBlocking {
    var assertions = 0
    fun verify(value: Boolean, message: String) { check(value) { message }; assertions++ }
    val fullHd = NativeCameraSize(1920, 1080)
    val ultraHd = NativeCameraSize(3840, 2160)
    val capable = NativeCameraDevice(
        id = "usb-fixture", facing = NativeCameraFacing.EXTERNAL,
        sizes = listOf(ultraHd, fullHd), fpsRanges = listOf(NativeCameraFpsRange(15, 30)),
        minimumFrameDurationsNs = mapOf(fullHd to 33_333_334L, ultraHd to 66_666_667L),
    )
    data class Case(
        val label: String,
        val device: NativeCameraDevice,
        val selection: NativeCameraCaptureSelection = NativeCameraCaptureSelection.Automatic,
        val size: NativeCameraSize = fullHd,
        val fps: Int = 24,
    )
    val cases = listOf(
        Case("1080p30", capable, fps = 30),
        Case("missing size metadata", capable.copy(minimumFrameDurationsNs = emptyMap())),
        Case("missing AE metadata", capable.copy(fpsRanges = emptyList())),
        Case("metadata for another size", capable.copy(minimumFrameDurationsNs = mapOf(ultraHd to 33_333_334L))),
        Case("explicit 4K15", capable, NativeCameraCaptureSelection(ultraHd), ultraHd, 15),
    )
    try {
        for (case in cases) for ((region, model, environment) in listOf(
            Triple("cn", RealtimeModel.X2_1_1_PREVIEW_CN, XmaxEnvironment.CHINA),
            Triple("global", RealtimeModel.X2_1_1_PREVIEW_US, XmaxEnvironment.GLOBAL),
        )) {
            // A second capable device must never lend its frame-rate metadata to the selected ID.
            NativeCameraCatalog.nextSnapshot = NativeCameraSnapshot(listOf(capable.copy(id = "other"), case.device))
            XmaxClient.cameraDevices = listOf(
                RealtimeCameraDevice("other", "Other", CameraPosition.FRONT),
                RealtimeCameraDevice(case.device.id, "USB fixture", null),
            )
            XmaxClient.managers.clear()
            val view = XmaxRealtimeVideoView()
            val controller = NativeXmaxController(Context(), view)
            fun checkRequest(manager: FixtureRealtimeManager, phase: String) {
                val prefix = "${case.label}/$region/$phase"
                verify(manager.cameraRequests.size == 1, "$prefix duplicated camera creation")
                val request = manager.cameraRequests.single()
                val capture = checkNotNull(request.captureFormat)
                verify(capture.fps == case.fps, "$prefix sent ${capture.fps} fps to capture instead of ${case.fps}")
                verify(capture.width == case.size.width && capture.height == case.size.height,
                    "$prefix changed the selected capture dimensions")
                verify(request.videoFormat.fps == 24, "$prefix changed the model/encoding input from 24 fps")
                verify(request.videoFormat.width == 1024 && request.videoFormat.height == 1920,
                    "$prefix changed the model/encoding input dimensions")
                verify(request.deviceId == case.device.id && request.position == CameraPosition.BACK,
                    "$prefix changed the selected RTC device or lost the external camera facing")
                verify(request.rotation == 90 && !request.useMicrophone,
                    "$prefix changed camera direction or enabled the microphone")
                verify(view.localTrack === manager.localStream.videoTrack && view.videoContentMode == VideoContentMode.FILL,
                    "$prefix did not bind the created local camera stream")
            }
            try {
                val deviceId = controller.preview(cameraDeviceId = case.device.id, cameraRotationDegrees = 90,
                    captureSelection = case.selection)
                val preview = XmaxClient.managers.single()
                verify(deviceId == case.device.id, "Preview returned another camera ID")
                checkRequest(preview, "preview")
                verify(preview.options.model == RealtimeModel.X2_1_1_PREVIEW_CN && preview.connectedSource == null,
                    "Local preview changed model or opened a provider session")

                val sessionId = controller.connect("nonfunctional-fixture-token", region, model.id,
                    cameraDeviceId = case.device.id, cameraRotationDegrees = 90, captureSelection = case.selection)
                verify(XmaxClient.managers.size == 2 && preview.closed, "Connect did not release the preview owner")
                val connected = XmaxClient.managers.last()
                checkRequest(connected, "connect")
                verify(connected.options.model == model && connected.configuration.environment == environment,
                    "Capture frame rate changed the negotiated model or region")
                verify(sessionId == "fixture-session" && connected.connectedSource === connected.localStream
                    && view.remoteTrack === connected.remoteStream.videoTrack,
                    "Connect did not use the camera stream that received the capture configuration")
            } finally {
                controller.close()
            }
            verify(XmaxClient.managers.all { it.closed } && view.localTrack == null && view.remoteTrack == null,
                "Controller fixture left a camera owner or view binding alive")
        }
        println("NativeXmaxController capture boundary passed ($assertions assertions).")
    } finally {
        FixtureMainDispatcher.close()
    }
}
