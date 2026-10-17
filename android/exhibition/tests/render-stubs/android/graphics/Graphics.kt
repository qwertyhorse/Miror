package android.graphics
object Color { const val BLACK = -16777216 }
class Canvas
class SurfaceTexture {
    var timestamp = 0L
    var isReleased = false
}
class Bitmap {
    enum class Config { ARGB_8888 }
    fun recycle() {}
    companion object { fun createBitmap(pixels: IntArray, width: Int, height: Int, config: Config) = Bitmap() }
}
