package ai.xmax.sdk.foundation.rtc

import ai.xmax.sdk.RealtimeLocalVideoFrameListener
import ai.xmax.sdk.RealtimeVideoFrame
import ai.xmax.sdk.XmaxError
import ai.xmax.sdk.XmaxErrorCode
import io.agora.base.VideoFrame
import io.agora.rtc2.video.VideoEncoderConfiguration
import java.lang.reflect.Proxy
import java.nio.ByteBuffer
import org.junit.Assert.*
import org.junit.Test

class CameraRotationFrameTest {
    @Test fun captureCorrectionChangesAgoraFrameOnceAndKeepsItsBufferAlive() {
        for (sensor in listOf(0, 90, 180, 270)) for (correction in listOf(0, 90, 180, 270)) {
            val pixels = Pixels()
            val frame = VideoFrame(pixels.buffer, sensor, 1_234_000)
            val processor = AgoraCameraFrameProcessor { 42L }
            processor.setRotation(correction)
            processor.start()
            val geometries = mutableListOf<Pair<CameraFrameGeometry, Boolean>>()
            val samples = mutableListOf<RealtimeVideoFrame>()
            assertTrue(processor.process(frame, { geometry, first -> geometries += geometry to first },
                object : RealtimeLocalVideoFrameListener {
                    override fun onFrame(frame: RealtimeVideoFrame, timestampMs: Long) {
                        assertEquals(42L, timestampMs)
                        samples += frame
                    }
                }))
            val expected = (sensor + correction) % 360
            assertEquals(expected, frame.rotation)
            assertEquals(listOf(CameraFrameGeometry(4, 2, expected) to true), geometries)
            assertEquals(expected, samples.single().rotationDegrees)
            assertEquals(4, samples.single().width)
            assertEquals(2, samples.single().height)
            assertEquals(1_234L, samples.single().presentationTimeUs)
            assertFalse(samples.single().isMirrored)
            assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8), samples.single().yData.bytes())
            assertArrayEquals(byteArrayOf(9, 10), samples.single().uData.bytes())
            assertEquals(1, pixels.references)
            frame.release()
            assertEquals(0, pixels.references)
        }
    }

    @Test fun invalidCorrectionFailsAndOrientationMapsToRealAgoraModes() {
        for (degrees in listOf(-90, 45, 360)) {
            val error = assertThrows(XmaxError::class.java) { AgoraCameraFrameProcessor().setRotation(degrees) }
            assertEquals(XmaxErrorCode.INVALID_CONFIGURATION, error.code)
        }
        assertEquals(VideoEncoderConfiguration.ORIENTATION_MODE.ORIENTATION_MODE_ADAPTIVE,
            RtcVideoConverter.convertCameraOrientation(CameraVideoOrientation.ADAPTIVE))
        assertEquals(VideoEncoderConfiguration.ORIENTATION_MODE.ORIENTATION_MODE_FIXED_PORTRAIT,
            RtcVideoConverter.convertCameraOrientation(CameraVideoOrientation.PORTRAIT))
        assertEquals(VideoEncoderConfiguration.ORIENTATION_MODE.ORIENTATION_MODE_FIXED_LANDSCAPE,
            RtcVideoConverter.convertCameraOrientation(CameraVideoOrientation.LANDSCAPE))
    }

    @Test fun textureRotationKeepsNativeBufferAndFullCaptureSizeWithoutPixelConversion() {
        for (sensor in listOf(0, 90, 180, 270)) for (correction in listOf(0, 90, 180, 270)) {
            val texture = Texture(width = 3840, height = 2160)
            val frame = VideoFrame(texture.buffer, sensor, 1_234_000)
            val processor = AgoraCameraFrameProcessor { 42L }
            processor.setRotation(correction)
            processor.start()
            val geometries = mutableListOf<Pair<CameraFrameGeometry, Boolean>>()
            assertTrue(processor.process(frame, { geometry, first -> geometries += geometry to first }, null))
            val expected = (sensor + correction) % 360
            assertSame(texture.buffer, frame.buffer)
            assertEquals(expected, frame.rotation)
            assertEquals(1_234_000L, frame.timestampNs)
            assertEquals(listOf(CameraFrameGeometry(3840, 2160, expected) to true), geometries)
            assertEquals(0, texture.conversions)
            assertEquals(1, texture.references)
            assertEquals(if (correction == 0) emptyList<String>() else listOf("retain", "release"), texture.lifetime)
            frame.release()
            assertEquals(0, texture.references)
        }
    }

    @Test fun texturePixelsConvertOnlyForAcceptedSamplesAndReleaseTemporaryI420() {
        val texture = Texture()
        val frame = VideoFrame(texture.buffer, 90, 1_234_000)
        val processor = AgoraCameraFrameProcessor { 42L }
        processor.start()
        val samples = mutableListOf<RealtimeVideoFrame>()
        val listener = object : RealtimeLocalVideoFrameListener {
            override fun onFrame(frame: RealtimeVideoFrame, timestampMs: Long) {
                assertEquals(42L, timestampMs)
                samples += frame
            }
        }
        assertTrue(processor.process(frame, null, object : RealtimeLocalVideoFrameListener {
            override fun shouldCaptureFrame(timestampMs: Long) = false
            override fun onFrame(frame: RealtimeVideoFrame, timestampMs: Long) = error("Rejected texture was sampled")
        }))
        assertTrue(processor.process(frame, null, listener) { false })
        assertEquals(0, texture.conversions)
        assertTrue(samples.isEmpty())

        processor.setRotation(270)
        assertTrue(processor.process(frame, null, listener))
        assertSame(texture.buffer, frame.buffer)
        assertEquals(1, texture.conversions)
        assertEquals(1, texture.references)
        assertEquals(0, requireNotNull(texture.convertedPixels).references)
        val sample = samples.single()
        assertEquals(4, sample.width)
        assertEquals(2, sample.height)
        assertEquals(0, sample.rotationDegrees)
        assertEquals(1_234L, sample.presentationTimeUs)
        assertFalse(sample.isMirrored)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8), sample.yData.bytes())
        assertArrayEquals(byteArrayOf(9, 10), sample.uData.bytes())
        assertArrayEquals(byteArrayOf(11, 12), sample.vData.bytes())
        frame.release()
        assertEquals(0, texture.references)
    }

    @Test fun firstCaptureAndGeometryChangesAreReportedAndStoppedFramesAreIgnored() {
        val processor = AgoraCameraFrameProcessor { 42L }
        val reports = mutableListOf<Pair<CameraFrameGeometry, Boolean>>()
        val pixels = Pixels()
        fun emit(rotation: Int): Boolean = processor.process(VideoFrame(pixels.buffer, rotation, 0),
            { geometry, first -> reports += geometry to first }, null)
        assertFalse(emit(0))
        processor.start()
        assertTrue(emit(0))
        assertTrue(emit(0))
        assertTrue(emit(90))
        assertEquals(listOf(CameraFrameGeometry(4, 2, 0) to true, CameraFrameGeometry(4, 2, 90) to false), reports)
        processor.stop()
        assertFalse(emit(270))
        processor.start()
        assertTrue(emit(270))
        assertEquals(CameraFrameGeometry(4, 2, 270) to true, reports.last())
    }

    @Test fun sampleGateAvoidsCopiesAndCaptureReplacementReleasesReservations() {
        val processor = AgoraCameraFrameProcessor { 42L }
        processor.start()
        val pixels = Pixels()
        val frame = VideoFrame(pixels.buffer, 0, 0)
        assertTrue(processor.process(frame, null, object : RealtimeLocalVideoFrameListener {
            override fun shouldCaptureFrame(timestampMs: Long) = false
            override fun onFrame(frame: RealtimeVideoFrame, timestampMs: Long) = error("Dropped frame copied")
        }))
        assertEquals(0, pixels.copies)
        var dropped = 0
        assertTrue(processor.process(frame, null, object : RealtimeLocalVideoFrameListener {
            override fun shouldCaptureFrame(timestampMs: Long): Boolean { processor.stop(); processor.start(); return true }
            override fun onFrame(frame: RealtimeVideoFrame, timestampMs: Long) = error("Stale capture sample escaped")
            override fun onFrameDropped() { dropped++ }
        }))
        assertEquals(1, dropped)
        assertEquals(1, pixels.references)
    }

    @Test fun listenerReplacementDuringCopyCannotDeliverAnOldSample() {
        val processor = AgoraCameraFrameProcessor { 42L }
        processor.start()
        val pixels = Pixels(onCopy = { processor.invalidateSamples() })
        var dropped = 0
        assertTrue(processor.process(VideoFrame(pixels.buffer, 0, 0), null, object : RealtimeLocalVideoFrameListener {
            override fun onFrame(frame: RealtimeVideoFrame, timestampMs: Long) = error("Retired listener was called")
            override fun onFrameDropped() { dropped++ }
        }))
        assertEquals(1, dropped)
        assertEquals(1, pixels.references)
    }

    /** Real Agora TextureBuffer interface; any accidental transform or pixel read fails. */
    private class Texture(width: Int = 4, height: Int = 2) {
        var references = 1
        var conversions = 0
        val lifetime = mutableListOf<String>()
        var convertedPixels: Pixels? = null
        val buffer: VideoFrame.TextureBuffer = Proxy.newProxyInstance(VideoFrame.TextureBuffer::class.java.classLoader,
            arrayOf(VideoFrame.TextureBuffer::class.java)) { _, method, _ ->
            when (method.name) {
                "getWidth" -> width
                "getHeight" -> height
                "toI420" -> {
                    check(width == 4 && height == 2) { "Unsampled full-resolution texture must not be converted" }
                    conversions++
                    Pixels().also { convertedPixels = it }.buffer
                }
                "retain" -> { check(references > 0); references++; lifetime += "retain"; null }
                "release" -> { check(references > 0); references--; lifetime += "release"; null }
                else -> error("Unexpected texture access: ${method.name}")
            }
        } as VideoFrame.TextureBuffer
    }

    private class Pixels(private val onCopy: () -> Unit = {}) {
        var references = 1
        var copies = 0
        val buffer: VideoFrame.I420Buffer = Proxy.newProxyInstance(VideoFrame.I420Buffer::class.java.classLoader,
            arrayOf(VideoFrame.I420Buffer::class.java)) { proxy, method, _ ->
            when (method.name) {
                "getWidth" -> 4
                "getHeight" -> 2
                "getStrideY" -> 5
                "getStrideU", "getStrideV" -> 3
                "getDataY" -> ByteBuffer.wrap(byteArrayOf(1, 2, 3, 4, 99, 5, 6, 7, 8))
                "getDataU" -> ByteBuffer.wrap(byteArrayOf(9, 10))
                "getDataV" -> ByteBuffer.wrap(byteArrayOf(11, 12))
                "toI420" -> { copies++; references++; onCopy(); proxy }
                "retain" -> { references++; null }
                "release" -> { references--; null }
                else -> error("Unexpected buffer access: ${method.name}")
            }
        } as VideoFrame.I420Buffer
    }

    private fun ByteBuffer.bytes(): ByteArray = ByteArray(remaining()).also { get(it) }
}
