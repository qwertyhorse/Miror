package android.graphics
class PointF(val x: Float, val y: Float)
class RectF(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    fun width() = right - left
    fun height() = bottom - top
    val isEmpty: Boolean get() = width() <= 0 || height() <= 0
    fun contains(x: Float, y: Float) = x >= left && x <= right && y >= top && y <= bottom
}
object Color {
    const val TRANSPARENT = 0
    const val WHITE = -1
    fun argb(a: Int, r: Int, g: Int, b: Int) = (a shl 24) or (r shl 16) or (g shl 8) or b
    fun red(c: Int) = (c shr 16) and 255
    fun green(c: Int) = (c shr 8) and 255
    fun blue(c: Int) = c and 255
}
class Bitmap(val width: Int, val height: Int) {
    var recycleCount = 0
    fun recycle() { check(++recycleCount == 1) { "Double recycle" } }
    enum class Config { ARGB_8888 }
    companion object {
        val created = mutableListOf<Bitmap>()
        fun createBitmap(width: Int, height: Int, config: Config) = Bitmap(width, height).also { created.add(it) }
    }
}
class Canvas(val bitmap: Bitmap? = null) {
    var bitmapDraws = 0
    var circleDraws = 0
    fun drawBitmap(bitmap: Bitmap, left: Float, top: Float, paint: Paint?) { check(bitmap.recycleCount == 0); bitmapDraws++ }
    fun drawLine(x1: Float, y1: Float, x2: Float, y2: Float, paint: Paint) { check(bitmap?.recycleCount == 0) }
    fun drawCircle(x: Float, y: Float, radius: Float, paint: Paint) { circleDraws++ }
    fun drawColor(color: Int, mode: PorterDuff.Mode) { check(bitmap?.recycleCount == 0) }
}
class Paint(flags: Int = 0) {
    var isAntiAlias = false
    var style = Style.FILL
    var strokeCap = Cap.ROUND
    var strokeJoin = Join.ROUND
    var strokeWidth = 0f
    var color = 0
    var alpha = 255
    var maskFilter: BlurMaskFilter? = null
    var xfermode: PorterDuffXfermode? = null
    var shader: Shader? = null
    fun reset() {}
    enum class Style { FILL, STROKE }
    enum class Cap { ROUND }
    enum class Join { ROUND }
    companion object { const val ANTI_ALIAS_FLAG = 1 }
}
class BlurMaskFilter(radius: Float, blur: Blur) { enum class Blur { NORMAL } }
object PorterDuff { enum class Mode { ADD, DST_OUT, CLEAR } }
class PorterDuffXfermode(mode: PorterDuff.Mode)
open class Shader { enum class TileMode { CLAMP } }
class RadialGradient(x: Float, y: Float, radius: Float, colors: IntArray, stops: FloatArray, tile: Shader.TileMode) : Shader()
