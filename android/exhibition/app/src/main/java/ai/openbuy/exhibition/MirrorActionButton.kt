package ai.openbuy.exhibition

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.text.TextUtils
import android.view.Gravity
import androidx.appcompat.widget.AppCompatButton

/** A normal accessible Button, with its icon and label centered together like the web flex button. */
internal class MirrorActionButton(context: Context, filled: Boolean = true) : AppCompatButton(context) {
    init {
        isAllCaps = false
        stateListAnimator = null
        backgroundTintList = null
        minimumHeight = 0
        minimumWidth = 0
        minHeight = 0
        minWidth = 0
        includeFontPadding = false
        setPadding(0, 0, 0, 0)
        gravity = Gravity.CENTER
        setSingleLine()
        // Single-line TextView otherwise lays out in a very wide horizontally scrolling
        // area and applies its own scroll offset, which our viewport drawing does not use.
        setHorizontallyScrolling(false)
        letterSpacing = 0f
        ellipsize = TextUtils.TruncateAt.END
        typeface = MirrorUiTheme.typeface(if (filled) 550 else 400)
        // Android 9/10 commonly ship only a regular CJK fallback. Keep the web's
        // requested weight while giving primary Chinese labels their medium-bold appearance.
        paint.isFakeBoldText = filled
        setTextColor(if (filled) Color.WHITE else Color.rgb(119, 98, 145))
    }

    fun setIcon(resource: Int, sizePx: Int, tint: Int? = null, gapPx: Int = 0) {
        val icon = context.getDrawable(resource)?.mutate() ?: return
        icon.setBounds(0, 0, sizePx, sizePx)
        if (tint != null) icon.setTint(tint)
        setCompoundDrawables(icon, null, null, null)
        compoundDrawablePadding = gapPx
    }

    override fun setEnabled(enabled: Boolean) {
        super.setEnabled(enabled)
        alpha = if (enabled) 1f else .65f
    }

    override fun onDraw(canvas: Canvas) {
        // Background/ripple are drawn by View. Preserve Button measurement, focus, touch and
        // accessibility semantics, but avoid TextView pinning the compound icon to its left edge.
        // View supplies a canvas in scrolled content coordinates. Our icon/text positions are
        // relative to the visible button, so undo any TextView bringTextIntoView scrolling.
        val viewport = canvas.save()
        canvas.translate(scrollX.toFloat(), scrollY.toFloat())
        val icon = compoundDrawables[0]
        paint.color = currentTextColor
        paint.drawableState = drawableState
        val iconWidth = icon?.bounds?.width() ?: 0
        val gap = if (icon != null && text.isNotEmpty()) compoundDrawablePadding else 0
        val label = TextUtils.ellipsize(text, paint,
            (width - paddingLeft - paddingRight - iconWidth - gap).coerceAtLeast(0).toFloat(),
            TextUtils.TruncateAt.END).toString()
        val labelWidth = paint.measureText(label)
        val start = paddingLeft + (width - paddingLeft - paddingRight - iconWidth - gap - labelWidth) / 2f
        if (icon != null) {
            val checkpoint = canvas.save()
            canvas.translate(start, (height - icon.bounds.height()) / 2f)
            icon.draw(canvas)
            canvas.restoreToCount(checkpoint)
        }
        val metrics = paint.fontMetrics
        val baseline = (height - metrics.ascent - metrics.descent) / 2f
        canvas.drawText(label, start + iconWidth + gap, baseline, paint)
        canvas.restoreToCount(viewport)
    }
}
