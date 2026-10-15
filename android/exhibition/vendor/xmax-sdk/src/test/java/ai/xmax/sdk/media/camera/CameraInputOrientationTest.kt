package ai.xmax.sdk.media.camera

import ai.xmax.sdk.CameraPosition
import ai.xmax.sdk.RealtimeVideoFormat
import ai.xmax.sdk.XmaxError
import ai.xmax.sdk.foundation.rtc.CameraFrameGeometry
import ai.xmax.sdk.foundation.rtc.CameraVideoOrientation
import ai.xmax.sdk.foundation.rtc.VideoEncodingConfiguration
import ai.xmax.sdk.service.media.MediaService
import ai.xmax.sdk.stream.encoding.EncodingController
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class CameraInputOrientationTest {
    private val format = RealtimeVideoFormat(704, 1280, 24)

    @Test fun actualFrameGeometryControlsEncoderOrientationForEveryQuarterTurn() = runBlocking {
        for ((width, height) in listOf(1280 to 704, 704 to 1280)) {
            for (rotation in listOf(0, 90, 180, 270)) {
                val fixture = CameraDeviceSelectionTest.Fixture(MediaService())
                fixture.engine.firstGeometry = CameraFrameGeometry(width, height, rotation)
                // The saved correction is already represented by the delivered frame geometry.
                fixture.media.createLocalCameraStream(format, CameraPosition.BACK,
                    cameraDeviceId = "usb-2", cameraRotationDegrees = 90)
                val prepared = checkNotNull(fixture.media.prepareConnectionVideoFormat())
                val quarterTurn = rotation == 90 || rotation == 270
                val expectedWidth = if (quarterTurn) height else width
                val expectedHeight = if (quarterTurn) width else height
                val expectedOrientation = if (expectedWidth <= expectedHeight)
                    CameraVideoOrientation.PORTRAIT else CameraVideoOrientation.LANDSCAPE

                EncodingController(fixture.rtc).configure(prepared)

                assertEquals(expectedWidth, prepared.width)
                assertEquals(expectedHeight, prepared.height)
                assertEquals(listOf(CameraVideoOrientation.ADAPTIVE, expectedOrientation), fixture.engine.orientations)
                assertEquals(listOf("orientation:$expectedOrientation", "encode:${expectedWidth}x${expectedHeight}"),
                    fixture.engine.operations.takeLast(2))
                assertEquals(expectedWidth, fixture.engine.encoding?.width)
                assertEquals(expectedHeight, fixture.engine.encoding?.height)
                assertEquals(listOf(90), fixture.engine.rotations)
                fixture.media.stopLocalStream()
            }
        }
    }

    @Test fun squareCameraInputUsesPortraitWithoutChangingTheRequestedSize() = runBlocking {
        val fixture = CameraDeviceSelectionTest.Fixture()
        fixture.rtc.initialize()
        fixture.rtc.startVideoCapture(704, 704, 24)
        fixture.rtc.configureVideoEncoding(VideoEncodingConfiguration(704, 704, 24))
        assertEquals(CameraVideoOrientation.PORTRAIT, fixture.engine.orientations.last())
        assertEquals(listOf("orientation:PORTRAIT", "encode:704x704"), fixture.engine.operations.takeLast(2))
        fixture.rtc.destroy()
    }

    @Test fun orientationFailurePreventsEncodingAndAllowsAnExplicitRetry() = runBlocking {
        val fixture = CameraDeviceSelectionTest.Fixture()
        fixture.engine.firstGeometry = CameraFrameGeometry(1280, 704, 90)
        fixture.media.createLocalCameraStream(format, CameraPosition.BACK)
        val prepared = checkNotNull(fixture.media.prepareConnectionVideoFormat())
        fixture.engine.orientationResult = -1

        val failure = runCatching { EncodingController(fixture.rtc).configure(prepared) }.exceptionOrNull()

        assertTrue(failure is XmaxError)
        assertNull(fixture.engine.encoding)
        assertFalse(fixture.engine.operations.any { it.startsWith("encode:") })
        assertEquals("orientation:PORTRAIT", fixture.engine.operations.last())
        fixture.engine.orientationResult = 0
        EncodingController(fixture.rtc).configure(prepared)
        assertEquals(listOf("orientation:PORTRAIT", "encode:704x1280"), fixture.engine.operations.takeLast(2))
        fixture.media.stopLocalStream()
    }

    @Test fun adaptiveResetFailureNeverStartsCameraCapture() = runBlocking {
        val fixture = CameraDeviceSelectionTest.Fixture()
        fixture.engine.orientationResult = -1
        val failure = runCatching {
            fixture.media.createLocalCameraStream(format, CameraPosition.BACK,
                cameraDeviceId = "usb-2", cameraRotationDegrees = 90)
        }.exceptionOrNull()
        assertTrue(failure is XmaxError)
        assertEquals(0, fixture.engine.captureStarts)
        assertEquals(listOf("select:usb-2", "rotation:90", "orientation:ADAPTIVE"), fixture.engine.operations)
        assertEquals(1, fixture.engineReleases)
        assertNull(fixture.media.currentTrack)
    }

    @Test fun externalInputClearsCameraRotationAndFixedOrientationBeforeSwitchingSource() = runBlocking {
        val fixture = CameraDeviceSelectionTest.Fixture()
        fixture.engine.firstGeometry = CameraFrameGeometry(1280, 704, 90)
        fixture.media.createLocalCameraStream(format, CameraPosition.BACK, cameraRotationDegrees = 90)
        EncodingController(fixture.rtc).configure(checkNotNull(fixture.media.prepareConnectionVideoFormat()))
        fixture.engine.operations.clear()

        fixture.rtc.useExternalVideoSource()

        assertEquals(listOf("orientation:ADAPTIVE", "rotation:0", "external"), fixture.engine.operations)
        assertNull(fixture.rtc.cameraFrameGeometry)
        fixture.engine.operations.clear()
        // Image input provides its own geometry and must not inherit the camera's orientation lock.
        fixture.rtc.configureVideoEncoding(VideoEncodingConfiguration(1280, 704, 24))
        assertEquals(listOf("encode:1280x704"), fixture.engine.operations)
        assertEquals(CameraVideoOrientation.ADAPTIVE, fixture.engine.orientations.last())
        assertEquals(0, fixture.engine.rotations.last())
        fixture.media.stopLocalStream()
    }

    @Test fun failedExternalResetNeverActivatesTheExternalSource() = runBlocking {
        for (failingOperation in listOf("orientation", "rotation")) {
            val fixture = CameraDeviceSelectionTest.Fixture()
            fixture.rtc.initialize()
            fixture.rtc.setVideoCaptureRotation(270)
            fixture.rtc.startVideoCapture(704, 1280, 24)
            fixture.rtc.configureVideoEncoding(VideoEncodingConfiguration(704, 1280, 24))
            fixture.engine.operations.clear()
            if (failingOperation == "orientation") fixture.engine.orientationResult = -1
            else fixture.engine.rotationResult = -1

            val failure = runCatching { fixture.rtc.useExternalVideoSource() }.exceptionOrNull()

            assertTrue(failure is XmaxError)
            val expected = if (failingOperation == "orientation") listOf("orientation:ADAPTIVE")
                else listOf("orientation:ADAPTIVE", "rotation:0")
            assertEquals(expected, fixture.engine.operations)
            assertFalse(fixture.engine.operations.contains("external"))
            fixture.rtc.destroy()
        }
    }

    @Test fun reopeningCaptureOnTheSameEngineResetsItsPreviousOrientationBeforeFirstFrame() = runBlocking {
        val fixture = CameraDeviceSelectionTest.Fixture()
        fixture.rtc.initialize()
        fixture.rtc.startVideoCapture(704, 1280, 24)
        fixture.rtc.configureVideoEncoding(VideoEncodingConfiguration(704, 1280, 24))
        fixture.rtc.stopVideoCapture()
        fixture.engine.operations.clear()

        fixture.rtc.startVideoCapture(1280, 704, 24)

        assertEquals(listOf("orientation:ADAPTIVE", "capture"), fixture.engine.operations)
        assertEquals(2, fixture.engine.captureStarts)
        fixture.rtc.configureVideoEncoding(VideoEncodingConfiguration(1280, 704, 24))
        assertEquals(listOf("orientation:LANDSCAPE", "encode:1280x704"), fixture.engine.operations.takeLast(2))
        fixture.rtc.destroy()
    }

    @Test fun encodingWithoutAnActiveCameraDoesNotSetAFixedOrientation() = runBlocking {
        val fixture = CameraDeviceSelectionTest.Fixture()
        fixture.rtc.initialize()
        fixture.rtc.configureVideoEncoding(VideoEncodingConfiguration(704, 1280, 24))
        assertEquals(listOf("encode:704x1280"), fixture.engine.operations)
        assertTrue(fixture.engine.orientations.isEmpty())
        fixture.rtc.destroy()
    }
}
