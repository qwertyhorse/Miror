package ai.xmax.sdk.foundation.rtc

import ai.xmax.sdk.XmaxError
import ai.xmax.sdk.XmaxErrorCode
import ai.xmax.sdk.CameraPosition
import ai.xmax.sdk.RealtimeVideoFrame
import com.ss.bytertc.engine.data.MirrorType
import com.ss.bytertc.engine.data.VideoPixelFormat
import com.ss.bytertc.engine.data.VideoRotation
import com.ss.bytertc.engine.video.IVideoFrame
import com.ss.bytertc.engine.video.LocalVideoSinkPosition
import java.lang.reflect.Proxy
import java.nio.ByteBuffer
import org.junit.Assert.*
import org.junit.Test

class CameraRotationFrameTest {
    @Test fun captureCorrectionUsesTheMatchingRtcRotation() {
        val rotations = listOf(VideoRotation.VIDEO_ROTATION_0, VideoRotation.VIDEO_ROTATION_90,
            VideoRotation.VIDEO_ROTATION_180, VideoRotation.VIDEO_ROTATION_270)
        listOf(0, 90, 180, 270).zip(rotations).forEach { (degrees, expected) ->
            assertEquals(expected, RtcVideoConverter.convertCaptureRotation(degrees))
        }
        for (degrees in listOf(-90, 45, 360)) {
            val error = runCatching { RtcVideoConverter.convertCaptureRotation(degrees) }.exceptionOrNull()
            assertTrue(error is XmaxError)
            assertEquals(XmaxErrorCode.INVALID_CONFIGURATION, (error as XmaxError).code)
        }
    }

    @Test fun analysisReceivesRtcRotationExactlyOnceAndKeepsRawPlaneDimensions() {
        // RTC may rotate pixels and report 0, or supply unrotated pixels plus metadata.
        // Preserve that contract; never add the saved camera correction a second time.
        for (degrees in listOf(0, 90, 180, 270)) {
            val rotation = RtcVideoConverter.convertCaptureRotation(degrees)
            val planes = arrayOf(byteArrayOf(1, 2, 99, 99, 3, 4, 99, 99), byteArrayOf(5), byteArrayOf(6))
            val frame = Proxy.newProxyInstance(IVideoFrame::class.java.classLoader,
                arrayOf(IVideoFrame::class.java)) { _, method, args ->
                when (method.name) {
                    "width", "height" -> 2
                    "pixelFormat" -> VideoPixelFormat.I420
                    "numberOfPlanes" -> 3
                    "timestampUs" -> 1234L
                    "rotation" -> rotation
                    "planeData" -> ByteBuffer.wrap(planes[args!![0] as Int])
                    "planeStride" -> if (args!![0] == 0) 4 else 1
                    else -> error("Unexpected frame access: ${method.name}")
                }
            } as IVideoFrame
            val sample = VolcRemoteVideoFrame(frame).copy()
            assertEquals(degrees, sample.rotationDegrees)
            assertFalse(sample.isMirrored)
            assertEquals(2, sample.width)
            assertEquals(2, sample.height)
            assertArrayEquals(byteArrayOf(1, 2, 3, 4), sample.yData.bytes())
            assertArrayEquals(byteArrayOf(5), sample.uData.bytes())
            assertArrayEquals(byteArrayOf(6), sample.vData.bytes())
        }
    }

    @Test fun postprocessedLocalSamplesPreserveRotationAndMarkTheSelectedCameraMirror() {
        val configuration = RtcVideoConverter.makeLocalVideoSinkConfiguration()
        assertEquals(LocalVideoSinkPosition.AFTER_PREPROCESS, configuration.position)
        assertEquals(VideoPixelFormat.I420, configuration.pixelFormat)
        var mirrorType = RtcVideoConverter.convertMirrorType(CameraPosition.FRONT)
        val samples = mutableListOf<RealtimeVideoFrame>()
        val rendered = mutableListOf<IVideoFrame>()
        val sink = VolcRemoteVideoFrameSink(object : RtcRemoteVideoSink {
            override fun onFirstFrame(width: Int, height: Int) = Unit
            override fun onFrame(frame: RtcRemoteVideoFrame) { samples += frame.copy() }
            override fun onError(error: XmaxError) = throw error
        }, isMirrored = { mirrorType == MirrorType.MIRROR_TYPE_RENDER_AND_ENCODER })
        sink.bind { object : RemoteFrameRenderer {
            override fun render(frame: IVideoFrame) { rendered += frame }
            override fun release() = Unit
        } }
        var references = 0
        val inputs = mutableListOf<IVideoFrame>()
        try {
            for (position in listOf(CameraPosition.FRONT, CameraPosition.BACK)) {
                mirrorType = RtcVideoConverter.convertMirrorType(position)
                for (degrees in listOf(0, 90, 180, 270)) {
                    val frame = Proxy.newProxyInstance(IVideoFrame::class.java.classLoader,
                        arrayOf(IVideoFrame::class.java)) { _, method, args ->
                        when (method.name) {
                            "width", "height" -> 2
                            "pixelFormat" -> VideoPixelFormat.I420
                            "numberOfPlanes" -> 3
                            "timestampUs" -> 1234L
                            "rotation" -> RtcVideoConverter.convertCaptureRotation(degrees)
                            "planeData" -> ByteBuffer.wrap(if (args!![0] == 0) byteArrayOf(1, 2, 3, 4) else byteArrayOf(5))
                            "planeStride" -> if (args!![0] == 0) 2 else 1
                            "addRef" -> { references++; Unit }
                            "releaseRef" -> { references--; 0L }
                            else -> error("Unexpected frame access: ${method.name}")
                        }
                    } as IVideoFrame
                    inputs += frame
                    sink.onFrame(frame)
                    val sample = samples.last()
                    assertEquals(position == CameraPosition.FRONT, sample.isMirrored)
                    assertEquals(degrees, sample.rotationDegrees)
                    assertArrayEquals(byteArrayOf(1, 2, 3, 4), sample.yData.bytes())
                    assertSame(frame, rendered.last())
                    assertEquals(1, references)
                }
            }
            assertEquals(8, samples.size)
            assertTrue(samples.first().isMirrored) // Changing camera cannot mutate already-owned samples.
            assertFalse(samples.last().isMirrored)
        } finally { sink.release() }
        assertEquals(0, references)
    }

    private fun ByteBuffer.bytes(): ByteArray = ByteArray(remaining()).also { get(it) }
}
