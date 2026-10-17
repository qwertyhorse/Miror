package ai.xmax.sdk

import ai.xmax.sdk.render.trajectory.TrajectoryBinding
import ai.xmax.sdk.render.trajectory.TrajectoryOverlayView
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.PointF
import android.view.View

fun main() {
    var assertions = 0
    fun verify(value: Boolean, message: String) { check(value) { message }; assertions++ }
    val renderer = DefaultTrajectoryEffectRenderer(Context())
    val canvas = Canvas()
    renderer.size(1966, 3333)
    renderer.onAttachedToWindow()
    repeat(30) { renderer.onDraw(canvas) }
    verify(Bitmap.created.isEmpty() && canvas.bitmapDraws == 0 && renderer.animationInvalidations == 0,
        "Idle 4K-sized view neither allocates nor draws a full-screen transparent bitmap")
    val id = TrajectoryID()
    fun point(x: Float) = TrajectoryPoint(id, PointF(x, 10f), PointF(0f, 0f), 1.0)
    renderer.renderBegan(listOf(point(10f)))
    renderer.onDraw(canvas)
    verify(Bitmap.created.isEmpty() && canvas.circleDraws > 0, "Stationary touch glow draws without a trail bitmap")
    renderer.renderMoved(listOf(point(20f)))
    renderer.onDraw(canvas)
    val first = Bitmap.created.single()
    verify(first.width == 1966 && first.height == 3333 && canvas.bitmapDraws == 1,
        "First movement lazily creates and draws the correctly sized trail")
    renderer.renderEnded(listOf(id))
    repeat(64) { renderer.onDraw(canvas) }
    verify(first.recycleCount == 0, "Existing 64-frame trail fade is retained")
    renderer.onDraw(canvas)
    verify(first.recycleCount == 1, "Fade completion releases the transparent trail")
    val drawsAfterFade = canvas.bitmapDraws
    val invalidationsAfterFade = renderer.animationInvalidations
    renderer.onDraw(canvas)
    verify(canvas.bitmapDraws == drawsAfterFade && renderer.animationInvalidations == invalidationsAfterFade,
        "An expired trail stops both bitmap drawing and animation scheduling")
    renderer.renderBegan(listOf(point(10f))); renderer.renderMoved(listOf(point(20f)))
    val second = Bitmap.created.last()
    renderer.size(640, 480)
    verify(second.recycleCount == 1 && Bitmap.created.size == 2, "Resize releases old pixels without eager replacement")
    renderer.onDraw(canvas)
    renderer.renderMoved(listOf(point(30f)))
    val third = Bitmap.created.last()
    verify(third.width == 640 && third.height == 480, "Moving an active touch after resize recreates current-size pixels")
    renderer.reset(); renderer.onDetachedFromWindow(); renderer.onAttachedToWindow(); renderer.onDraw(canvas)
    verify(third.recycleCount == 1 && Bitmap.created.size == 3 && Bitmap.created.all { it.recycleCount == 1 },
        "Reset/detach/reattach stays idle and releases every allocated bitmap exactly once")

    val overlay = TrajectoryOverlayView(Context())
    verify(overlay.visibility == View.GONE, "An unbound overlay is excluded from measurement and composition")
    overlay.setVideoFormat(RealtimeVideoFormat(1080, 1920))
    val binding = TrajectoryBinding()
    overlay.setBinding(binding)
    verify(overlay.visibility == View.VISIBLE && !overlay.isEnabled, "Binding restores visibility before geometry exists")
    overlay.size(640, 480)
    verify(overlay.isEnabled && overlay.isClickable, "The first layout enables the newly visible overlay")
    overlay.setRequestedInteractionEnabled(false)
    verify(overlay.visibility == View.GONE && !overlay.isEnabled && !overlay.isClickable, "Disabling interaction removes the overlay")
    overlay.setRequestedInteractionEnabled(true)
    verify(overlay.visibility == View.VISIBLE && overlay.isEnabled, "Re-enabling restores the measured interactive overlay")
    overlay.clearBinding(binding)
    verify(overlay.visibility == View.GONE && !overlay.isEnabled, "Unbinding hides and disables the overlay")
    println("TrajectoryRenderLifecycle: $assertions assertions passed; actual SDK views with counted graphics fixtures, no GPU/camera claims")
}
