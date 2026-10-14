package ai.openbuy.exhibition

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/** Compact version of the native terminal-pairing card, with no duplicate setup instructions. */
internal class NativePairingView(context: Context) : LinearLayout(context) {
    val title = label("设备绑定", MirrorUiTheme.INK)
    val code = label("····", Color.rgb(118, 83, 191)).apply {
        typeface = MirrorUiTheme.typeface(650)
        letterSpacing = .086f
        fontFeatureSettings = "tnum"
        accessibilityLiveRegion = ACCESSIBILITY_LIVE_REGION_POLITE
    }
    private val card = LinearLayout(context).apply {
        orientation = VERTICAL
        gravity = Gravity.CENTER
    }
    private val icon = ImageView(context).apply {
        setImageResource(R.drawable.mirror_pair_device)
        scaleType = ImageView.ScaleType.CENTER_INSIDE
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    private val eyebrow = label("OPENBUY.AI · 镜端连接", Color.rgb(160, 141, 183)).apply { letterSpacing = .2f }
    private val hint = label("在工作人员后台输入绑定码", MirrorUiTheme.PAIRING_MUTED)

    init {
        orientation = VERTICAL
        gravity = Gravity.CENTER
        addView(card)
        card.addView(icon)
        card.addView(eyebrow)
        card.addView(title)
        card.addView(hint)
        card.addView(code)
    }

    fun arrange(stageWidth: Float) {
        // Web pairing uses a 540px card; scale to the same canvas units as the mirror controls.
        val scale = stageWidth / 540f * .80f
        fun px(value: Float) = (value * scale).toInt()
        background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
            intArrayOf(Color.rgb(236, 229, 254), Color.rgb(248, 247, 252), Color.rgb(248, 247, 252)))
        card.layoutParams = LayoutParams((stageWidth * .86f).toInt(), LayoutParams.WRAP_CONTENT)
        card.setPadding(px(28f), px(42f), px(28f), px(36f))
        card.background = MirrorUiTheme.rounded(0xedffffff.toInt(), 20f * scale, MirrorUiTheme.PAIRING_BORDER)
        card.elevation = 2f * scale
        icon.layoutParams = LayoutParams(px(70f), px(70f)).apply { bottomMargin = px(27f) }
        icon.setPadding(px(13f), px(13f), px(13f), px(13f))
        icon.background = MirrorUiTheme.rounded(Color.rgb(241, 235, 253), 20f * scale)
        eyebrow.setTextSize(TypedValue.COMPLEX_UNIT_PX, 10f * scale)
        title.setTextSize(TypedValue.COMPLEX_UNIT_PX, 28f * scale)
        title.typeface = MirrorUiTheme.typeface(550)
        title.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
            topMargin = px(14f); bottomMargin = px(16f)
        }
        hint.setTextSize(TypedValue.COMPLEX_UNIT_PX, 14f * scale)
        code.setTextSize(TypedValue.COMPLEX_UNIT_PX, 58f * scale)
        code.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = px(30f) }
    }

    private fun label(value: String, color: Int) = TextView(context).apply {
        text = value
        gravity = Gravity.CENTER
        setTextColor(color)
        includeFontPadding = false
    }
}
