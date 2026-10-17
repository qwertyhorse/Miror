package ai.xmax.sdk.media.camera

import ai.xmax.sdk.*
import ai.xmax.sdk.foundation.rtc.CameraFrameGeometry
import ai.xmax.sdk.service.media.MediaService
import ai.xmax.sdk.stream.encoding.EncodingController
import ai.xmax.sdk.stream.room.RoomEvent
import android.view.View
import androidx.compose.ui.unit.IntSize
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import sun.misc.Unsafe

class CameraGeometryIntegrationTest {
    private val format = RealtimeVideoFormat(1024, 1920, 24, 700, 1700, RealtimeVideoEncoderPreference.MAINTAIN_QUALITY)
    private val rules = MediaService()

    @Test fun nonSquareRtcFramesResolveBeforeReadyAndDriveBothEncoderAndGeneration() = runBlocking {
        val samples = listOf(0, 90, 180, 270).map { CameraFrameGeometry(1920, 1024, it) } +
            CameraFrameGeometry(1024, 1920, 0) // RTC has already rotated the pixels.
        for (geometry in samples) {
            val fixture = CameraDeviceSelectionTest.Fixture(rules)
            fixture.engine.firstGeometry = geometry
            val ready = mutableListOf<RealtimeVideoFormat?>()
            fixture.media.setCameraPreviewReadyListener { ready += fixture.media.currentVideoFormat }
            val stream = fixture.media.createLocalCameraStream(format, CameraPosition.BACK,
                cameraDeviceId = "usb-2", cameraRotationDegrees = 90)
            assertTrue("A first frame alone does not mean a preview was bound", ready.isEmpty())
            fixture.rtc.bindLocalVideo(viewToken(), VideoContentMode.FILL)
            val expected = format.copy(width = geometry.displayWidth, height = geometry.displayHeight)
            assertEquals(listOf(expected), ready)
            val prepared = checkNotNull(fixture.media.prepareConnectionVideoFormat())
            assertEquals(expected, prepared)
            assertEquals(expected, stream.videoTrack?.videoFormat)
            EncodingController(fixture.rtc).configure(prepared)
            assertEquals(expected.width, fixture.engine.encoding?.width)
            assertEquals(expected.height, fixture.engine.encoding?.height)
            assertEquals(24, fixture.engine.encoding?.frameRate)
            assertEquals(700, fixture.engine.encoding?.minimumBitrate)
            assertEquals(1700, fixture.engine.encoding?.maximumBitrate)
            assertEquals(listOf(expected.width, expected.height), size(RoomEvent.start("user", "task", prepared, RealtimeContext("test"), 700, 1700)))
            fixture.engine.geometryListener?.invoke(CameraFrameGeometry(960, 640, 0), false)
            assertEquals("Late size changes must not alter an active generation", expected, fixture.media.currentVideoFormat)
            assertEquals(listOf(expected.width, expected.height), size(RoomEvent.changeCondition("user", "task",
                checkNotNull(fixture.media.currentVideoFormat), RealtimeContext("next"))))
            fixture.media.stopLocalStream()
        }
    }

    @Test fun latestSizeIsAlignedWithoutChangingFpsBitratesAndIsReevaluatedForReconnect() = runBlocking {
        val fixture = CameraDeviceSelectionTest.Fixture(rules)
        fixture.engine.firstGeometry = CameraFrameGeometry(1920, 1024, 0)
        fixture.media.createLocalCameraStream(format, CameraPosition.BACK)
        val latest = CameraFrameGeometry(1920, 1080, 90)
        fixture.engine.geometryListener?.invoke(latest, false)
        val resolved = rules.resolveModelInputSize(IntSize(1024, 1920))
        val prepared = fixture.media.prepareConnectionVideoFormat()
        assertEquals(format.copy(width = resolved.width, height = resolved.height), prepared)
        fixture.engine.geometryListener?.invoke(CameraFrameGeometry(1920, 1024, 0), false)
        assertEquals(prepared, fixture.media.currentVideoFormat)
        // Core calls prepare only while disconnected, once per connection attempt.
        assertEquals(format.copy(width = 1920, height = 1024), fixture.media.prepareConnectionVideoFormat())
        fixture.media.stopLocalStream()
    }

    @Test fun connectingWithoutABoundPreviewWaitsForAValidActualFrame() = runBlocking {
        val fixture = CameraDeviceSelectionTest.Fixture(rules)
        fixture.media.createLocalCameraStream(format, CameraPosition.BACK)
        val pending = async(start = CoroutineStart.UNDISPATCHED) { fixture.media.prepareConnectionVideoFormat() }
        assertFalse(pending.isCompleted)
        fixture.engine.geometryListener?.invoke(CameraFrameGeometry(1920, 1024, 270), false)
        assertFalse("A size change is not proof that capture has started", pending.isCompleted)
        fixture.engine.geometryListener?.invoke(CameraFrameGeometry(0, 1024, 0), true)
        fixture.engine.geometryListener?.invoke(CameraFrameGeometry(1920, 1024, 45), true)
        assertFalse(pending.isCompleted)
        fixture.engine.geometryListener?.invoke(CameraFrameGeometry(1920, 1024, 270), true)
        assertEquals(format, pending.await())
        fixture.media.stopLocalStream()
    }

    @Test fun oldCaptureAndEngineCallbacksCannotPopulateANewCameraOrAnExternalSource() = runBlocking {
        val fixture = CameraDeviceSelectionTest.Fixture(rules)
        fixture.media.createLocalCameraStream(format, CameraPosition.BACK)
        val old = checkNotNull(fixture.engine.geometryListener)
        val pending = async(start = CoroutineStart.UNDISPATCHED) { fixture.media.prepareConnectionVideoFormat() }
        fixture.media.stopLocalStream()
        assertTrue(runCatching { pending.await() }.exceptionOrNull() is CancellationException)
        old(CameraFrameGeometry(1920, 1024, 0), true)
        assertNull(fixture.rtc.cameraFrameGeometry)
        fixture.media.createLocalCameraStream(format, CameraPosition.BACK)
        old(CameraFrameGeometry(1920, 1024, 0), true)
        assertNull(fixture.rtc.cameraFrameGeometry)
        val current = checkNotNull(fixture.engine.geometryListener)
        current(CameraFrameGeometry(1920, 1024, 90), true)
        assertEquals(format, fixture.media.prepareConnectionVideoFormat())
        fixture.rtc.useExternalVideoSource()
        current(CameraFrameGeometry(1920, 1024, 0), false)
        assertNull(fixture.rtc.cameraFrameGeometry)
        fixture.media.stopLocalStream()
    }

    @Test fun queuedReadyFromAnOldSourceDoesNotAnnounceANewCamera() = runBlocking {
        val callbacks = mutableListOf<Runnable>()
        val dispatcher = object : CoroutineDispatcher() {
            override fun dispatch(context: CoroutineContext, block: Runnable) { callbacks += block }
        }
        val fixture = CameraDeviceSelectionTest.Fixture(rules, CoroutineScope(dispatcher))
        fixture.engine.firstGeometry = CameraFrameGeometry(1920, 1024, 90)
        var ready = 0
        fixture.media.setCameraPreviewReadyListener { ready++ }
        fixture.media.createLocalCameraStream(format, CameraPosition.BACK)
        fixture.rtc.bindLocalVideo(viewToken(), VideoContentMode.FILL)
        assertEquals(1, callbacks.size)
        fixture.media.stopLocalStream()
        fixture.engine.firstGeometry = null
        fixture.media.createLocalCameraStream(format, CameraPosition.BACK)
        callbacks.removeAt(0).run()
        assertEquals(0, ready)
        assertNull(fixture.rtc.cameraFrameGeometry)
        fixture.media.stopLocalStream()
    }

    @Test fun stoppedCaptureCallbacksCannotAffectARestartOnTheSameEngineLease() = runBlocking {
        val fixture = CameraDeviceSelectionTest.Fixture(rules)
        fixture.rtc.initialize()
        fixture.rtc.startVideoCapture(1024, 1920, 24)
        val old = checkNotNull(fixture.engine.geometryListener)
        fixture.rtc.stopVideoCapture()
        fixture.rtc.startVideoCapture(1024, 1920, 24)
        old(CameraFrameGeometry(1920, 1024, 0), true)
        assertNull(fixture.rtc.cameraFrameGeometry)
        fixture.engine.geometryListener?.invoke(CameraFrameGeometry(1920, 1024, 90), true)
        assertEquals(CameraFrameGeometry(1920, 1024, 90), fixture.rtc.awaitCameraFrameGeometry())
        fixture.rtc.destroy()
    }

    @Test fun callersTimeoutIsNotConvertedToACameraError() = runBlocking {
        val fixture = CameraDeviceSelectionTest.Fixture(rules)
        fixture.media.createLocalCameraStream(format, CameraPosition.BACK)
        val failure = runCatching { withTimeout(20L) { fixture.media.prepareConnectionVideoFormat() } }.exceptionOrNull()
        assertTrue(failure is TimeoutCancellationException)
        fixture.media.stopLocalStream()
    }

    private fun size(event: String): List<Int> {
        val size = JSONObject(event).getJSONObject("params").getJSONArray("size")
        return listOf(size.getInt(0), size.getInt(1))
    }

    /** The fake engine accepts a View token without touching Android's stubbed UI methods. */
    private fun viewToken(): View {
        val unsafe = Unsafe::class.java.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null) as Unsafe
        return unsafe.allocateInstance(View::class.java) as View
    }
}
