package android.view
import android.content.Context

open class View(val context: Context) {
    var width = 2160
    var height = 3840
}
interface SurfaceHolder {
    fun setFixedSize(width: Int, height: Int)
    fun setSizeFromLayout()
}
class FixtureHolder : SurfaceHolder {
    val requestedSizes = mutableListOf<Pair<Int, Int>>()
    val requestThreads = mutableListOf<String>()
    override fun setFixedSize(width: Int, height: Int) {
        requestedSizes += width to height
        requestThreads += Thread.currentThread().name
    }
    override fun setSizeFromLayout() { error("A 4K layout must never request an unbounded buffer") }
}
