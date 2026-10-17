package ai.xmax.sdk.render.video

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VideoRenderSizeTest {
    private val fullHdPixels = 1920 * 1080

    @Test
    fun `default and views below the limit retain their original geometry`() {
        for ((width, height) in listOf(2160 to 3840, 0 to 200, 200 to 0)) {
            assertEquals(VideoRenderSize(width, height), VideoRenderSize.limited(width, height, 0))
        }
        for ((width, height) in listOf(480 to 720, 1920 to 1080, 1080 to 1920, 0 to 0)) {
            assertEquals(VideoRenderSize(width, height), VideoRenderSize.limited(width, height, fullHdPixels))
        }
    }

    @Test
    fun `4K portrait and landscape surfaces reduce to full HD without changing aspect`() {
        assertEquals(VideoRenderSize(1080, 1920), VideoRenderSize.limited(2160, 3840, fullHdPixels))
        assertEquals(VideoRenderSize(1920, 1080), VideoRenderSize.limited(3840, 2160, fullHdPixels))
    }

    @Test
    fun `main stage stays within the pixel budget with less than one pixel aspect rounding`() {
        val width = 1965
        val height = 3333
        val result = VideoRenderSize.limited(width, height, fullHdPixels)
        assertTrue(result.width.toLong() * result.height <= fullHdPixels)
        assertTrue(result.width < width && result.height < height)
        assertTrue(kotlin.math.abs(result.width.toDouble() / result.height - width.toDouble() / height) < 1.0 / result.height)
        assertEquals(VideoRenderSize(result.height, result.width), VideoRenderSize.limited(height, width, fullHdPixels))
    }

    @Test
    fun `tiny caps and extreme aspect ratios never produce zero dimensions or exceed the cap`() {
        val dimensions = listOf(1 to Int.MAX_VALUE, Int.MAX_VALUE to 1, 2 to 8192,
            8192 to 2, Int.MAX_VALUE to Int.MAX_VALUE, 117 to 331)
        for ((width, height) in dimensions) {
            for (limit in listOf(1, 2, 7, 256, fullHdPixels, Int.MAX_VALUE)) {
                val result = VideoRenderSize.limited(width, height, limit)
                assertTrue("width $width x $height / $limit", result.width in 1..width)
                assertTrue("height $width x $height / $limit", result.height in 1..height)
                assertTrue("budget $width x $height / $limit", result.width.toLong() * result.height <= limit)
            }
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun `negative limit is rejected`() {
        VideoRenderSize.limited(1080, 1920, -1)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `negative dimensions are rejected`() {
        VideoRenderSize.limited(-1, 1920, fullHdPixels)
    }
}
