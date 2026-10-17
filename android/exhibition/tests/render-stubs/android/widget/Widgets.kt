package android.widget
import android.content.Context
import android.graphics.Bitmap
import android.util.AttributeSet
import android.view.View
import android.view.ViewGroup

open class FrameLayout(context: Context, attrs: AttributeSet? = null, style: Int = 0) : ViewGroup(context) {
    class LayoutParams(val width: Int, val height: Int, val gravity: Int = 0) {
        companion object { const val MATCH_PARENT = -1 }
    }
    override fun onMeasure(widthSpec: Int, heightSpec: Int) {
        super.onMeasure(widthSpec, heightSpec)
        children.filter { it.visibility != GONE }.forEach {
            it.measure(MeasureSpec.makeMeasureSpec(measuredWidth - paddingLeft - paddingRight, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(measuredHeight - paddingTop - paddingBottom, MeasureSpec.EXACTLY))
        }
    }
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        children.filter { it.visibility != GONE }.forEach {
            it.layout(paddingLeft, paddingTop, paddingLeft + it.measuredWidth, paddingTop + it.measuredHeight)
        }
    }
}
class ImageView(context: Context) : View(context) {
    enum class ScaleType { FIT_CENTER, CENTER_CROP }
    var scaleType = ScaleType.FIT_CENTER
    fun setImageBitmap(value: Bitmap) {}
    fun setImageDrawable(value: Any?) {}
}
