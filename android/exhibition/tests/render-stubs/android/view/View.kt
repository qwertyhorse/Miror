package android.view

import android.content.Context
import android.graphics.Canvas
import android.graphics.SurfaceTexture
import android.os.Callbacks

open class View(val context: Context) {
    var width = 0; var height = 0
    var measuredWidth = 0; var measuredHeight = 0
    var paddingLeft = 0; var paddingRight = 0; var paddingTop = 0; var paddingBottom = 0
    var pivotX = 0f; var pivotY = 0f; var scaleX = 1f; var scaleY = 1f; var alpha = 1f
    var visibility = VISIBLE
    var parent: ViewGroup? = null
    var layoutParams: android.widget.FrameLayout.LayoutParams? = null
    var isAttachedToWindow = false
    var layoutRequests = 0
    val animation = Animator(this)
    fun setBackgroundColor(color: Int) {}
    fun requestLayout() { layoutRequests++ }
    fun bringToFront() { parent?.let { it.children.remove(this); it.children.add(this) } }
    fun animate() = animation
    fun postOnAnimation(callback: Runnable) { Callbacks.add(callback) }
    fun removeCallbacks(callback: Runnable) { Callbacks.remove(callback) }
    open fun onAttachedToWindow() { isAttachedToWindow = true }
    open fun onDetachedFromWindow() { isAttachedToWindow = false }
    open fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {}
    open fun onMeasure(widthSpec: Int, heightSpec: Int) {
        measuredWidth = MeasureSpec.getSize(widthSpec); measuredHeight = MeasureSpec.getSize(heightSpec)
    }
    open fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {}
    open fun dispatchDraw(canvas: Canvas) {}
    fun measure(widthSpec: Int, heightSpec: Int) { onMeasure(widthSpec, heightSpec) }
    fun layout(left: Int, top: Int, right: Int, bottom: Int) {
        val oldWidth = width; val oldHeight = height
        width = right - left; height = bottom - top
        val changed = oldWidth != width || oldHeight != height
        if (changed) onSizeChanged(width, height, oldWidth, oldHeight)
        onLayout(changed, left, top, right, bottom)
    }
    object MeasureSpec {
        const val EXACTLY = 0x40000000
        fun getSize(value: Int) = value and 0x3fffffff
        fun makeMeasureSpec(size: Int, mode: Int) = size or mode
    }
    companion object { const val VISIBLE = 0; const val GONE = 8 }
}

open class ViewGroup(context: Context) : View(context) {
    var clipChildren = true
    val children = mutableListOf<View>()
    fun addView(view: View, params: android.widget.FrameLayout.LayoutParams) = addView(view, children.size, params)
    fun addView(view: View, index: Int, params: android.widget.FrameLayout.LayoutParams) {
        check(view.parent == null)
        children.add(index, view); view.parent = this; view.layoutParams = params
        if (isAttachedToWindow) view.onAttachedToWindow()
    }
    fun removeView(view: View) {
        if (!children.remove(view)) return
        if (view.isAttachedToWindow) view.onDetachedFromWindow()
        view.parent = null
    }
    override fun onAttachedToWindow() { super.onAttachedToWindow(); children.toList().forEach { it.onAttachedToWindow() } }
    override fun onDetachedFromWindow() { children.toList().forEach { it.onDetachedFromWindow() }; super.onDetachedFromWindow() }
}

class Animator(private val view: View) {
    var duration = 0L
    private var targetAlpha = 1f
    fun cancel() {}
    fun alpha(value: Float) = apply { targetAlpha = value }
    fun setDuration(value: Long) = apply { duration = value }
    fun setInterpolator(value: Any) = this
    fun start() { view.alpha = targetAlpha }
}

object Gravity { const val TOP = 48; const val LEFT = 3 }

open class TextureView(context: Context) : View(context) {
    var surfaceTexture: SurfaceTexture? = null
    private var listener: SurfaceTextureListener? = null
    open fun setSurfaceTextureListener(value: SurfaceTextureListener?) { listener = value }
    open fun getSurfaceTextureListener() = listener
    fun present(timestamp: Long) {
        val surface = surfaceTexture ?: SurfaceTexture().also {
            surfaceTexture = it; listener?.onSurfaceTextureAvailable(it, width, height)
        }
        surface.timestamp = timestamp
        listener?.onSurfaceTextureUpdated(surface)
    }
    override fun onDetachedFromWindow() {
        surfaceTexture?.let { listener?.onSurfaceTextureDestroyed(it); it.isReleased = true }
        super.onDetachedFromWindow()
    }
    interface SurfaceTextureListener {
        fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int)
        fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int)
        fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean
        fun onSurfaceTextureUpdated(surface: SurfaceTexture)
    }
}

open class SurfaceView(context: Context) : View(context) {
    val holder = SurfaceHolder()
    var zOrderChanges = 0
    fun setZOrderOnTop(value: Boolean) { zOrderChanges++ }
    fun setZOrderMediaOverlay(value: Boolean) { zOrderChanges++ }
}
class SurfaceHolder {
    val fixedSizes = mutableListOf<Pair<Int, Int>>()
    var layoutSizeRestores = 0
    fun setFixedSize(width: Int, height: Int) { fixedSizes.add(width to height) }
    fun setSizeFromLayout() { layoutSizeRestores++ }
}
