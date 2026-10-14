package ai.xmax.sdk.media.camera

import ai.xmax.sdk.*
import ai.xmax.sdk.foundation.permissions.PermissionManaging
import ai.xmax.sdk.foundation.rtc.*
import ai.xmax.sdk.media.MediaController
import android.view.View
import androidx.compose.ui.unit.IntSize
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class CameraDeviceSelectionTest {
    @Test fun enumerationIsFreshAndDoesNotCaptureAndReleasesItsEngine() = runBlocking {
        val fixture = Fixture()
        assertEquals(listOf("usb-2"), fixture.media.enumerateCameraDevices().map { it.id })
        fixture.engine.devices = listOf(RealtimeCameraDevice("usb-3", "Replacement", null))
        assertEquals(listOf("usb-3"), fixture.media.enumerateCameraDevices().map { it.id })
        assertEquals(2, fixture.permissionChecks)
        assertEquals(0, fixture.engine.captureStarts)
        assertNull(fixture.engine.selectedId)
        fixture.media.stopLocalStream()
        assertEquals(1, fixture.engineReleases)
    }

    @Test fun exactDeviceIdIsUsedAndUnknownFacingIsNotPretendedToBeFront() = runBlocking {
        val fixture = Fixture()
        val stream = fixture.media.createLocalCameraStream(format, CameraPosition.FRONT, cameraDeviceId = "usb-2")
        assertEquals("usb-2", fixture.engine.selectedId)
        assertNull(fixture.engine.selectedPosition)
        assertNull(stream.videoTrack?.position)
        assertNull(fixture.engine.switchedPosition)
        assertEquals(1, fixture.engine.captureStarts)
        fixture.media.stopLocalStream()
    }

    @Test fun explicitFrontDeviceRetainsItsFacingRegardlessOfLegacyPosition() = runBlocking {
        val fixture = Fixture()
        fixture.engine.devices = listOf(RealtimeCameraDevice("front-4", "Front", CameraPosition.FRONT))
        val stream = fixture.media.createLocalCameraStream(format, CameraPosition.BACK, cameraDeviceId = "front-4")
        assertEquals(CameraPosition.FRONT, fixture.engine.selectedPosition)
        assertEquals(CameraPosition.FRONT, stream.videoTrack?.position)
        fixture.media.stopLocalStream()
    }

    @Test fun unavailableAndBlankIdsNeverSilentlyChooseAnotherCamera() = runBlocking {
        for (id in listOf("removed-usb", "", " usb-2 ")) {
            val fixture = Fixture()
            val failure = runCatching {
                fixture.media.createLocalCameraStream(format, CameraPosition.BACK, cameraDeviceId = id)
            }.exceptionOrNull()
            assertTrue(failure is XmaxError)
            assertEquals(0, fixture.engine.captureStarts)
            assertNull(fixture.engine.selectedId)
            assertNull(fixture.engine.switchedPosition)
            assertEquals(1, fixture.engineReleases)
        }
    }

    @Test fun deviceRemovedAfterEnumerationCannotPassTheFreshSelectionCheck() = runBlocking {
        val fixture = Fixture()
        val id = fixture.media.enumerateCameraDevices().single().id
        fixture.engine.devices = emptyList()
        assertTrue(runCatching {
            fixture.media.createLocalCameraStream(format, CameraPosition.BACK, cameraDeviceId = id)
        }.exceptionOrNull() is XmaxError)
        assertEquals(0, fixture.engine.captureStarts)
        assertNull(fixture.engine.switchedPosition)
    }

    @Test fun nonzeroDeviceSelectionResultFailsBeforeCaptureAndReleasesResources() = runBlocking {
        for (result in listOf(-1, 1)) {
            val fixture = Fixture()
            fixture.engine.selectionResult = result
            val error = runCatching {
                fixture.media.createLocalCameraStream(format, CameraPosition.BACK, cameraDeviceId = "usb-2")
            }.exceptionOrNull()
            assertTrue(error is XmaxError)
            assertTrue(error?.message.orEmpty().contains("setVideoCaptureDevice"))
            assertEquals(0, fixture.engine.captureStarts)
            assertNull(fixture.engine.switchedPosition)
            assertEquals(1, fixture.engineReleases)
        }
    }

    @Test fun legacyCallsStillSelectByPosition() = runBlocking {
        val fixture = Fixture()
        val stream = fixture.media.createLocalCameraStream(format, CameraPosition.BACK)
        assertEquals(CameraPosition.BACK, fixture.engine.switchedPosition)
        assertEquals(CameraPosition.BACK, stream.videoTrack?.position)
        assertNull(fixture.engine.selectedId)
        assertEquals(0, fixture.engine.enumerations)
        fixture.media.stopLocalStream()
    }

    private class Fixture {
        val engine = FakeEngine()
        var engineReleases = 0
        var permissionChecks = 0
        private val rtc = RtcManager(
            RtcEngineManager({ engine }, { engineReleases++ }),
            callbackScope = CoroutineScope(Dispatchers.Unconfined),
        )
        val media = MediaController(rtc, CameraController(
            rtcManager = rtc,
            permissionManager = object : PermissionManaging {
                override suspend fun ensureCameraPermission() { permissionChecks++ }
                override suspend fun ensureMicrophonePermission() = Unit
            },
            mediaService = object : MediaServicing {
                override val model = RealtimeModel.X2_0
                override fun resolveModelInputSize(size: IntSize) = size
            },
        ))
    }

    private class FakeEngine : RtcPlatformEngine {
        var devices = listOf(RealtimeCameraDevice("usb-2", "External camera", null))
        var enumerations = 0
        var selectedId: String? = null
        var selectedPosition: CameraPosition? = null
        var switchedPosition: CameraPosition? = null
        var captureStarts = 0
        var selectionResult = 0
        override fun enumerateCameraDevices(): List<RealtimeCameraDevice> {
            enumerations++
            return devices
        }
        override fun selectCameraDevice(deviceId: String, position: CameraPosition?): Int {
            selectedId = deviceId
            selectedPosition = position
            return selectionResult
        }
        override fun switchCamera(position: CameraPosition): Int {
            switchedPosition = position
            return 0
        }
        override fun startVideoCapture(width: Int, height: Int, frameRate: Int): Int {
            captureStarts++
            return 0
        }
        override fun stopVideoCapture() = 0
        override fun configureVideoEncoding(configuration: VideoEncodingConfiguration) = 0
        override fun pushExternalVideoFrame(frame: VideoFrame, seiData: ByteArray?) = Unit
        override fun pushExternalAudioFrame(frame: AudioFrame) = Unit
        override fun useExternalVideoSource() = 0
        override fun startExternalAudioSource() = 0
        override fun stopExternalAudioSource() = 0
        override fun startAudioCapture() = 0
        override fun stopAudioCapture() = 0
        override fun bindLocalVideo(view: View, contentMode: VideoContentMode) = 0
        override fun unbindLocalVideo() = 0
        override fun bindRemoteVideo(userId: String, view: View, contentMode: VideoContentMode) = 0
        override fun unbindRemoteVideo(userId: String) = 0
        override fun setCameraPreviewReadyListener(listener: (() -> Unit)?) = Unit
        override fun setRemoteVideoFrameListener(streamId: String, listener: RtcRemoteVideoSink?) = 0
        override fun setRemoteAudioVolume(streamId: String, volume: Int) = 0
        override fun setEventListener(listener: RtcEventListener?) = Unit
        override fun setQualityListener(listener: RtcQualityListener?) = Unit
        override fun createRoom(roomId: String): RtcPlatformRoom? = error("Enumeration/preview must not create a room")
    }

    private companion object {
        val format = RealtimeVideoFormat(704, 1280, 24)
    }
}
