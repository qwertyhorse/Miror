package ai.xmax.sdk.media.camera

import ai.xmax.sdk.*
import ai.xmax.sdk.foundation.rtc.CameraFrameGeometry
import ai.xmax.sdk.service.media.MediaService
import ai.xmax.sdk.stream.encoding.EncodingController
import ai.xmax.sdk.stream.room.RoomEvent
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CameraCaptureFormatTest {
    private val fourK = RealtimeCameraCaptureFormat(3840, 2160, 30)
    private val outputFormat = RealtimeVideoFormat(704, 1280, 24)

    @Test fun fourKCaptureIsNotPrescaledAndRotatedModelEncoderAndRequestsStayConsistent() = runBlocking {
        for (rotation in listOf(0, 90, 180, 270)) {
            val fixture = CameraDeviceSelectionTest.Fixture(MediaService())
            fixture.engine.firstGeometry = CameraFrameGeometry(3840, 2160, rotation)
            fixture.media.createLocalCameraStream(outputFormat, CameraPosition.BACK,
                cameraDeviceId = "usb-2", cameraRotationDegrees = rotation, captureFormat = fourK)

            assertEquals(listOf(fourK), fixture.engine.captures)
            assertEquals(RealtimeCameraCaptureInfo(3840, 2160, rotation), fixture.media.cameraCaptureInfo())
            val prepared = checkNotNull(fixture.media.prepareConnectionVideoFormat())
            val quarterTurn = rotation == 90 || rotation == 270
            // X2.0 scales 4K to the 1,280,000-pixel limit, then floors each side to 32:
            // about 1508.49 x 848.53 becomes 1504 x 832 (1,251,328 pixels).
            val expectedWidth = if (quarterTurn) 832 else 1504
            val expectedHeight = if (quarterTurn) 1504 else 832
            assertEquals(expectedWidth, prepared.width)
            assertEquals(expectedHeight, prepared.height)
            assertEquals(24, prepared.fps)
            assertTrue(prepared.width * prepared.height in 600_000..1_280_000)
            assertEquals(0, prepared.width % 32)
            assertEquals(0, prepared.height % 32)

            EncodingController(fixture.rtc).configure(prepared)
            assertEquals(expectedWidth, fixture.engine.encoding?.width)
            assertEquals(expectedHeight, fixture.engine.encoding?.height)
            assertEquals(24, fixture.engine.encoding?.frameRate)
            for (event in listOf(
                RoomEvent.start("user", "task", prepared, RealtimeContext("first")),
                RoomEvent.changeCondition("user", "task", prepared, RealtimeContext("next")),
            )) {
                val size = JSONObject(event).getJSONObject("params").getJSONArray("size")
                assertEquals(listOf(expectedWidth, expectedHeight), listOf(size.getInt(0), size.getInt(1)))
            }
            fixture.media.stopLocalStream()
        }
    }

    @Test fun captureInfoReportsActualDriverFallbackRatherThanTheFourKRequest() = runBlocking {
        val fixture = CameraDeviceSelectionTest.Fixture(MediaService())
        fixture.engine.firstGeometry = CameraFrameGeometry(1280, 720, 90)
        fixture.media.createLocalCameraStream(outputFormat, CameraPosition.BACK, captureFormat = fourK)
        assertEquals(listOf(fourK), fixture.engine.captures)
        assertEquals(RealtimeCameraCaptureInfo(1280, 720, 90), fixture.media.cameraCaptureInfo())
        val prepared = checkNotNull(fixture.media.prepareConnectionVideoFormat())
        assertEquals(704, prepared.width)
        assertEquals(1280, prepared.height)
        fixture.media.stopLocalStream()
    }

    @Test fun missingCaptureOverrideKeepsLegacyModelAdjustedCaptureAndFps() = runBlocking {
        val fixture = CameraDeviceSelectionTest.Fixture(MediaService())
        val stream = fixture.media.createLocalCameraStream(RealtimeVideoFormat(3840, 2160, 24), CameraPosition.BACK)
        assertEquals(listOf(RealtimeCameraCaptureFormat(1504, 832, 24)), fixture.engine.captures)
        assertEquals(RealtimeVideoFormat(1504, 832, 24), stream.videoTrack?.videoFormat)
        fixture.media.stopLocalStream()
    }

    @Test fun invalidCaptureRequestsFailBeforePermissionSelectionOrCapture() = runBlocking {
        val invalid = listOf(
            fourK.copy(width = 0), fourK.copy(height = -2), fourK.copy(width = 3839),
            fourK.copy(height = 2159), fourK.copy(width = 8194), fourK.copy(height = 8194),
            fourK.copy(fps = 0), fourK.copy(fps = 121),
        )
        for (request in invalid) {
            val fixture = CameraDeviceSelectionTest.Fixture(MediaService())
            val failure = runCatching {
                fixture.media.createLocalCameraStream(outputFormat, CameraPosition.BACK,
                    cameraDeviceId = "usb-2", captureFormat = request)
            }.exceptionOrNull()
            assertTrue(failure is XmaxError)
            assertEquals(XmaxErrorCode.INVALID_CONFIGURATION, (failure as XmaxError).code)
            assertEquals(0, fixture.permissionChecks)
            assertTrue(fixture.engine.operations.isEmpty())
            assertNull(fixture.media.currentTrack)
            assertNull(fixture.media.cameraCaptureInfo())
            assertEquals(1, fixture.engineReleases)
        }
        RealtimeCameraCaptureFormat(2, 2, 1).validate()
        RealtimeCameraCaptureFormat(8192, 8192, 120).validate()
    }

    @Test fun captureInfoDoesNotLeakAcrossStoppedCameraRestartOrExternalSource() = runBlocking {
        val fixture = CameraDeviceSelectionTest.Fixture(MediaService())
        assertNull(fixture.media.cameraCaptureInfo())
        fixture.media.createLocalCameraStream(outputFormat, CameraPosition.BACK, captureFormat = fourK)
        assertNull(fixture.media.cameraCaptureInfo())
        val oldListener = checkNotNull(fixture.engine.geometryListener)
        oldListener(CameraFrameGeometry(3840, 2160, 90), true)
        assertEquals(RealtimeCameraCaptureInfo(3840, 2160, 90), fixture.media.cameraCaptureInfo())
        fixture.media.stopLocalStream()
        assertNull(fixture.media.cameraCaptureInfo())
        oldListener(CameraFrameGeometry(3840, 2160, 90), false)
        assertNull(fixture.media.cameraCaptureInfo())

        fixture.media.createLocalCameraStream(outputFormat, CameraPosition.BACK)
        oldListener(CameraFrameGeometry(3840, 2160, 90), true)
        assertNull(fixture.media.cameraCaptureInfo())
        val currentListener = checkNotNull(fixture.engine.geometryListener)
        currentListener(CameraFrameGeometry(1280, 704, 0), true)
        assertEquals(RealtimeCameraCaptureInfo(1280, 704, 0), fixture.media.cameraCaptureInfo())
        fixture.rtc.useExternalVideoSource()
        currentListener(CameraFrameGeometry(3840, 2160, 90), false)
        assertNull(fixture.media.cameraCaptureInfo())
        fixture.media.stopLocalStream()
    }

    @Test fun unusedManagerCaptureInfoDoesNotCreateComponentsOrCapture() = runBlocking {
        val manager = XmaxRealtimeManager(RealtimeConfiguration(), { _, _, _ ->
            error("Reading capture info must not create media components")
        })
        assertNull(manager.cameraCaptureInfo())
    }
}
