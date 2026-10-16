package android.graphics
import java.io.OutputStream
import java.util.concurrent.atomic.AtomicInteger
class Bitmap(val width: Int, val height: Int, val encodedSize: (Int) -> Int = { 5 }) {
    val recycleCount = AtomicInteger()
    val qualities = mutableListOf<Int>()
    val scaled = mutableListOf<Bitmap>()
    val isRecycled: Boolean get() = recycleCount.get() > 0
    fun recycle() { check(recycleCount.incrementAndGet() == 1) { "Double recycle" } }
    enum class CompressFormat { JPEG }
    fun compress(format: CompressFormat, quality: Int, output: OutputStream): Boolean {
        check(width <= 960 && height <= 960 && quality in 0..100 && format == CompressFormat.JPEG)
        qualities.add(quality)
        output.write(ByteArray(encodedSize(quality)))
        return true
    }
    companion object {
        fun createScaledBitmap(source: Bitmap, width: Int, height: Int, filter: Boolean) =
            Bitmap(width, height, source.encodedSize).also { source.scaled.add(it) }
    }
}
