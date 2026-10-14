package ai.openbuy.exhibition

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import kotlin.math.roundToInt

/** Shared native tokens from mirror-screen.css and terminal-pairing.css. */
internal object MirrorUiTheme {
    val BRAND = Color.rgb(112, 99, 208)
    val PRIMARY = Color.rgb(117, 96, 219)
    val INK = Color.rgb(64, 50, 123)
    val MUTED = Color.rgb(119, 98, 145)
    val SURFACE = Color.rgb(250, 249, 252)
    val BORDER = Color.rgb(221, 213, 241)
    val PAIRING_MUTED = Color.rgb(147, 131, 159)
    val PAIRING_BORDER = Color.rgb(230, 222, 243)

    fun dp(context: Context, value: Float): Int = (context.resources.displayMetrics.density * value).roundToInt()

    fun typeface(weight: Int = 550): Typeface = Typeface.create(Typeface.create("sans-serif", Typeface.NORMAL), weight, false)

    fun rounded(color: Int, radius: Float, strokeColor: Int? = null, strokeWidth: Int = 1) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = radius
        if (strokeColor != null) setStroke(strokeWidth, strokeColor)
    }
}
