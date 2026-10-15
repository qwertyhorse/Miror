package android.graphics
import java.io.OutputStream
import java.util.concurrent.atomic.AtomicInteger
class Bitmap(val width: Int, val height: Int) {
    val recycleCount = AtomicInteger()
    val isRecycled: Boolean get() = recycleCount.get() > 0
    fun recycle() { check(recycleCount.incrementAndGet() == 1) { "Double recycle" } }
    enum class CompressFormat { JPEG }
    fun compress(format: CompressFormat, quality: Int, output: OutputStream): Boolean {
        check(width <= 480 && height <= 480 && quality == 70 && format == CompressFormat.JPEG)
        output.write(byteArrayOf(0xff.toByte(), 0xd8.toByte(), 1, 0xff.toByte(), 0xd9.toByte()))
        return true
    }
    companion object {
        fun createScaledBitmap(source: Bitmap, width: Int, height: Int, filter: Boolean) = Bitmap(width, height)
    }
}
