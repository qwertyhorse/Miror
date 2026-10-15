package ai.openbuy.exhibition

import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.roundToInt

/** Pure I420 sampler: rotation and reduction happen before allocating the ARGB bitmap. */
internal object NativeCameraPixels {
    data class Pixels(val width: Int, val height: Int, val argb: IntArray)

    fun convert(width: Int, height: Int, rotation: Int, y: ByteBuffer, u: ByteBuffer, v: ByteBuffer,
        yStride: Int, uStride: Int, vStride: Int, longEdge: Int): Pixels {
        require(width in 1..8192 && height in 1..8192 && rotation in listOf(0, 90, 180, 270))
        require(yStride >= width && uStride >= (width + 1) / 2 && vStride >= (width + 1) / 2)
        require(y.remaining().toLong() >= (height - 1L) * yStride + width)
        val chromaHeight = (height + 1) / 2
        require(u.remaining().toLong() >= (chromaHeight - 1L) * uStride + (width + 1) / 2)
        require(v.remaining().toLong() >= (chromaHeight - 1L) * vStride + (width + 1) / 2)
        val turned = rotation == 90 || rotation == 270
        val rotatedWidth = if (turned) height else width
        val rotatedHeight = if (turned) width else height
        val scale = minOf(1.0, longEdge.coerceIn(64, 640).toDouble() / max(rotatedWidth, rotatedHeight))
        val outWidth = max(1, (rotatedWidth * scale).roundToInt())
        val outHeight = max(1, (rotatedHeight * scale).roundToInt())
        val yOffset = y.position(); val uOffset = u.position(); val vOffset = v.position()
        val pixels = IntArray(outWidth * outHeight)
        for (row in 0 until outHeight) {
            val ry = row * rotatedHeight / outHeight
            for (column in 0 until outWidth) {
                val rx = column * rotatedWidth / outWidth
                val sx = when (rotation) { 90 -> ry; 180 -> width - 1 - rx; 270 -> width - 1 - ry; else -> rx }
                val sy = when (rotation) { 90 -> height - 1 - rx; 180 -> height - 1 - ry; 270 -> rx; else -> ry }
                val yy = max(0, (y.get(yOffset + sy * yStride + sx).toInt() and 255) - 16)
                val uu = (u.get(uOffset + sy / 2 * uStride + sx / 2).toInt() and 255) - 128
                val vv = (v.get(vOffset + sy / 2 * vStride + sx / 2).toInt() and 255) - 128
                val r = ((298 * yy + 409 * vv + 128) shr 8).coerceIn(0, 255)
                val g = ((298 * yy - 100 * uu - 208 * vv + 128) shr 8).coerceIn(0, 255)
                val b = ((298 * yy + 516 * uu + 128) shr 8).coerceIn(0, 255)
                pixels[row * outWidth + column] = (255 shl 24) or (r shl 16) or (g shl 8) or b
            }
        }
        return Pixels(outWidth, outHeight, pixels)
    }
}
