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
        assertEquals(listOf(0), fixture.engine.rotations)
        fixture.media.stopLocalStream()
    }

    @Test fun cameraRotationIsAppliedAfterSelectionAndBeforeTheFirstCapture() = runBlocking {
        for (degrees in listOf(0, 90, 180, 270)) {
            val fixture = Fixture()
            fixture.media.createLocalCameraStream(format, CameraPosition.FRONT,
                cameraDeviceId = "usb-2", cameraRotationDegrees = degrees)
            assertEquals(listOf("select:usb-2", "rotation:$degrees", "orientation:ADAPTIVE", "capture"),
                fixture.engine.operations)
            fixture.media.stopLocalStream()
        }
    }

    @Test fun invalidRotationNeverSelectsOrStartsTheCamera() = runBlocking {
        for (degrees in listOf(-90, 1, 45, 360, Int.MAX_VALUE)) {
            val fixture = Fixture()
            val error = runCatching {
                fixture.media.createLocalCameraStream(format, CameraPosition.FRONT,
                    cameraDeviceId = "usb-2", cameraRotationDegrees = degrees)
            }.exceptionOrNull()
            assertTrue(error is XmaxError)
            assertEquals(XmaxErrorCode.INVALID_CONFIGURATION, (error as XmaxError).code)
            assertEquals(0, fixture.permissionChecks)
            assertTrue(fixture.engine.operations.isEmpty())
            assertEquals(1, fixture.engineReleases)
        }
    }

    @Test fun rotationFailureStopsBeforeCaptureAndAllowsRetry() = runBlocking {
        val fixture = Fixture()
        fixture.engine.rotationResult = -1
        val error = runCatching {
            fixture.media.createLocalCameraStream(format, CameraPosition.FRONT,
                cameraDeviceId = "usb-2", cameraRotationDegrees = 90)
        }.exceptionOrNull()
        assertTrue(error is XmaxError)
        assertTrue(error?.message.orEmpty().contains("setVideoCaptureRotation"))
        assertEquals(0, fixture.engine.captureStarts)
        assertEquals(1, fixture.engineReleases)
        assertNull(fixture.media.currentTrack)
        fixture.engine.rotationResult = 0
        fixture.media.createLocalCameraStream(format, CameraPosition.FRONT,
            cameraDeviceId = "usb-2", cameraRotationDegrees = 270)
        assertEquals(listOf(90, 270), fixture.engine.rotations)
        assertEquals(1, fixture.engine.captureStarts)
        fixture.media.stopLocalStream()
    }

    @Test fun defaultRotationResetsAPreviousCameraCorrection() = runBlocking {
        val fixture = Fixture()
        fixture.media.createLocalCameraStream(format, CameraPosition.FRONT, cameraRotationDegrees = 180)
        fixture.media.stopLocalStream()
        fixture.media.createLocalCameraStream(format, CameraPosition.FRONT)
        assertEquals(listOf(180, 0), fixture.engine.rotations)
        assertEquals(2, fixture.engine.captureStarts)
        fixture.media.stopLocalStream()
    }

    internal class Fixture(private val mediaRules: MediaServicing? = null, callbackScope: CoroutineScope = CoroutineScope(Dispatchers.Unconfined)) {
        val engine = FakeEngine()
        var engineReleases = 0
        var permissionChecks = 0
        val rtc = RtcManager(
            RtcEngineManager({ engine }, { engineReleases++ }),
            callbackScope = callbackScope,
        )
        val camera = CameraController(
            rtcManager = rtc,
            permissionManager = object : PermissionManaging {
                override suspend fun ensureCameraPermission() { permissionChecks++ }
                override suspend fun ensureMicrophonePermission() = Unit
            },
            mediaService = mediaRules ?: object : MediaServicing {
                override val model = RealtimeModel.X2_0
                override fun resolveModelInputSize(size: IntSize) = size
            },
        )
        val media = MediaController(rtc, camera)
    }

    internal class FakeEngine : RtcPlatformEngine {
        var devices = listOf(RealtimeCameraDevice("usb-2", "External camera", null))
        var enumerations = 0
        var selectedId: String? = null
        var selectedPosition: CameraPosition? = null
        var switchedPosition: CameraPosition? = null
        var captureStarts = 0
        var selectionResult = 0
        var rotationResult = 0
        var orientationResult = 0
        val rotations = mutableListOf<Int>()
        val orientations = mutableListOf<CameraVideoOrientation>()
        val operations = mutableListOf<String>()
        var firstGeometry: CameraFrameGeometry? = null
        var geometryListener: ((CameraFrameGeometry, Boolean) -> Unit)? = null
        var encoding: VideoEncodingConfiguration? = null
        override fun enumerateCameraDevices(): List<RealtimeCameraDevice> {
            enumerations++
            return devices
        }
        override fun selectCameraDevice(deviceId: String, position: CameraPosition?): Int {
            operations += "select:$deviceId"
            selectedId = deviceId
            selectedPosition = position
            return selectionResult
        }
        override fun switchCamera(position: CameraPosition): Int {
            operations += "switch:$position"
            switchedPosition = position
            return 0
        }
        override fun startVideoCapture(width: Int, height: Int, frameRate: Int): Int {
            operations += "capture"
            captureStarts++
            firstGeometry?.let { geometryListener?.invoke(it, true) }
            return 0
        }
        override fun setVideoCaptureRotation(rotationDegrees: Int): Int {
            operations += "rotation:$rotationDegrees"
            rotations += rotationDegrees
            return rotationResult
        }
        override fun setVideoOrientation(orientation: CameraVideoOrientation): Int {
            operations += "orientation:$orientation"
            orientations += orientation
            return orientationResult
        }
        override fun stopVideoCapture() = 0
        override fun configureVideoEncoding(configuration: VideoEncodingConfiguration): Int {
            operations += "encode:${configuration.width}x${configuration.height}"
            encoding = configuration
            return 0
        }
        override fun pushExternalVideoFrame(frame: VideoFrame, seiData: ByteArray?) = Unit
        override fun pushExternalAudioFrame(frame: AudioFrame) = Unit
        override fun useExternalVideoSource(): Int { operations += "external"; return 0 }
        override fun startExternalAudioSource() = 0
        override fun stopExternalAudioSource() = 0
        override fun startAudioCapture() = 0
        override fun stopAudioCapture() = 0
        override fun bindLocalVideo(view: View, contentMode: VideoContentMode) = 0
        override fun unbindLocalVideo() = 0
        override fun bindRemoteVideo(userId: String, view: View, contentMode: VideoContentMode) = 0
        override fun unbindRemoteVideo(userId: String) = 0
        override fun setCameraPreviewReadyListener(listener: ((CameraFrameGeometry, Boolean) -> Unit)?) { geometryListener = listener }
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
