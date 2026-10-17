package android.view
import android.content.Context
import android.graphics.Canvas
open class View(val context: Context) {
    val resources get() = context.resources
    var width = 0
    var height = 0
    var isClickable = false
    var isFocusable = false
    var isEnabled = true
    var visibility = VISIBLE
    var parent: ViewGroup? = null
    var animationInvalidations = 0
    fun setBackgroundColor(color: Int) {}
    fun invalidate() {}
    fun postInvalidateOnAnimation() { animationInvalidations++ }
    open fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {}
    open fun onAttachedToWindow() {}
    open fun onDetachedFromWindow() {}
    open fun onDraw(canvas: Canvas) {}
    open fun onTouchEvent(event: MotionEvent) = false
    open fun performClick() = false
    fun size(width: Int, height: Int) {
        val oldWidth = this.width; val oldHeight = this.height
        this.width = width; this.height = height
        onSizeChanged(width, height, oldWidth, oldHeight)
    }
    companion object { const val VISIBLE = 0; const val GONE = 8 }
}
open class ViewGroup(context: Context) : View(context) {
    var clipChildren = true
    val children = mutableListOf<View>()
    fun removeView(view: View) { children.remove(view); view.parent = null }
    fun addView(view: View, params: Any) { children.add(view); view.parent = this }
}
class MotionEvent(val actionMasked: Int, val actionIndex: Int = 0, val pointerCount: Int = 1) {
    fun getPointerId(index: Int) = index
    fun getX(index: Int) = 10f
    fun getY(index: Int) = 10f
    companion object { const val ACTION_DOWN = 0; const val ACTION_POINTER_DOWN = 5; const val ACTION_MOVE = 2; const val ACTION_UP = 1; const val ACTION_POINTER_UP = 6; const val ACTION_CANCEL = 3 }
}
class Choreographer {
    fun interface FrameCallback { fun doFrame(time: Long) }
    fun postFrameCallback(callback: FrameCallback) {}
    fun removeFrameCallback(callback: FrameCallback) {}
    companion object { private val instance = Choreographer(); fun getInstance() = instance }
}
