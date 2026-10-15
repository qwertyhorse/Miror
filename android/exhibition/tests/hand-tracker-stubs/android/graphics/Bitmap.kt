package android.graphics
import java.util.concurrent.atomic.AtomicInteger
class Bitmap(private val pixelWidth: Int, private val pixelHeight: Int) {
 val width: Int get() { check(!isRecycled); return pixelWidth }
 val height: Int get() { check(!isRecycled); return pixelHeight }
 val isRecycled: Boolean get() = recycleCount.get() > 0
 val recycleCount = AtomicInteger()
 fun recycle() { check(recycleCount.incrementAndGet() == 1) { "Double recycle" } }
 companion object {
  fun createScaledBitmap(source: Bitmap, width: Int, height: Int, filter: Boolean) = Bitmap(width, height)
 }
}
