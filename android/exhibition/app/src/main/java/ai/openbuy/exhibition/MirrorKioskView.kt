package ai.openbuy.exhibition

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import ai.xmax.sdk.VideoContentMode
import ai.xmax.sdk.XmaxRealtimeVideoView

/** Native equivalent of mirror-screen.css. All geometry scales with the 9:16 canvas. */
internal class MirrorKioskView(context: Context) : FrameLayout(context) {
    val surface = FrameLayout(context)
    val skin = ImageView(context).apply { scaleType = ImageView.ScaleType.FIT_XY }
    private val brandTexture = ImageView(context).apply {
        scaleType = ImageView.ScaleType.FIT_XY; setImageResource(R.drawable.mirror_brand_texture)
    }
    val logo = ImageView(context).apply {
        scaleType = ImageView.ScaleType.FIT_CENTER; setImageResource(R.drawable.mirror_logo)
        contentDescription = "OpenBuyAI"
    }
    val stage = FrameLayout(context).apply { clipToOutline = true }
    val video = XmaxRealtimeVideoView(context).apply {
        videoContentMode = VideoContentMode.FILL; isInteractionEnabled = false
    }
    val poster = ImageView(context).apply { scaleType = ImageView.ScaleType.FIT_CENTER; visibility = GONE }
    val empty = text("暂无可用素材", Color.rgb(145, 134, 172))
    val pairing = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER }
    val pairTitle = text("设备绑定", INK)
    val pairCode = text("····", PURPLE).apply {
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL); letterSpacing = .12f
    }
    private val pairingHint = text("在展会后台绑定此设备", Color.rgb(145, 134, 172))
    val drawer = MirrorMaterialDrawerView(context)
    val status = text("连接后台…", Color.rgb(99, 83, 127)).apply { maxLines = 3 }
    val primary = action("开始体验", true)
    val continueButton = action("继续体验", false).apply { visibility = GONE }
    private val actions = LinearLayout(context).apply { gravity = Gravity.CENTER }
    val home = action("", false).apply {
        contentDescription = "返回首页"; visibility = GONE
    }
    val settings = action("", false).apply {
        contentDescription = "设备设置"
    }
    private var skinKey = ""
    private var geometryWidth = 0
    private var geometryHeight = 0
    private var primaryIcon = R.drawable.mirror_play

    init {
        setBackgroundColor(Color.BLACK)
        surface.setBackgroundColor(Color.rgb(238, 235, 249))
        addView(surface)
        surface.addView(brandTexture)
        surface.addView(skin)
        surface.addView(logo)
        surface.addView(stage)
        stage.addView(video, LayoutParams(-1, -1))
        stage.addView(poster, LayoutParams(-1, -1))
        stage.addView(empty, LayoutParams(-1, -1))
        pairing.addView(pairTitle)
        pairing.addView(pairCode)
        pairing.addView(pairingHint)
        stage.addView(pairing, LayoutParams(-1, -1))
        stage.addView(status)
        // Like the web drawer, this occupies the stage without consuming the video's space.
        stage.addView(drawer, LayoutParams(-1, -1))
        actions.addView(primary)
        actions.addView(continueButton)
        stage.addView(actions)
        surface.addView(home)
        surface.addView(settings)
    }

    fun applySkin(preset: String, custom: Boolean) {
        val key = if (custom) "custom" else preset
        if (skinKey == key) return
        skinKey = key
        skin.tag = null
        skin.alpha = 1f
        when (key) {
            "brand" -> {
                surface.setBackgroundColor(PURPLE)
                brandTexture.visibility = VISIBLE
                skin.setImageDrawable(null)
                logo.setColorFilter(Color.WHITE)
            }
            "custom" -> {
                surface.setBackgroundColor(Color.rgb(238, 235, 249))
                brandTexture.visibility = GONE
                skin.setImageDrawable(null)
                logo.clearColorFilter()
            }
            else -> {
                surface.setBackgroundColor(Color.rgb(238, 235, 249))
                brandTexture.visibility = GONE
                skin.setImageResource(R.drawable.mirror_crystal)
                logo.clearColorFilter()
            }
        }
        home.background = rounded(if (key == "brand") 0x1fffffff else 0x80ffffff.toInt(), width * .014f)
        updateIcons()
        requestLayout()
    }

    fun setPrimaryIcon(stopping: Boolean, recovering: Boolean) {
        val next = if (recovering) R.drawable.mirror_recover else if (stopping) R.drawable.mirror_stop else R.drawable.mirror_play
        if (next != primaryIcon) { primaryIcon = next; updateIcons() }
    }

    private fun updateIcons() {
        if (geometryWidth == 0) return
        val unit = geometryWidth / 100f
        fun icon(button: Button, resource: Int, size: Float, tint: Int? = null) {
            val drawable = context.getDrawable(resource)?.mutate() ?: return
            drawable.setBounds(0, 0, size.toInt(), size.toInt())
            if (tint != null) drawable.setTint(tint)
            button.setCompoundDrawables(drawable, null, null, null)
            button.compoundDrawablePadding = (unit * 1.5f).toInt()
        }
        icon(primary, primaryIcon, unit * 3.5f)
        icon(continueButton, R.drawable.mirror_resume, unit * 2.8f)
        icon(home, R.drawable.mirror_home, unit * 3.4f, if (skinKey == "brand") Color.WHITE else null)
        icon(settings, R.drawable.mirror_settings, unit * 3.4f, if (skinKey == "brand") Color.WHITE else null)
        primary.setPadding((unit * 4).toInt(), 0, (unit * 4).toInt(), 0)
        continueButton.setPadding((unit * 2.5f).toInt(), 0, (unit * 2.5f).toInt(), 0)
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val availableWidth = MeasureSpec.getSize(widthMeasureSpec)
        val availableHeight = MeasureSpec.getSize(heightMeasureSpec)
        val canvasWidth = minOf(availableWidth, (availableHeight * 9f / 16f).toInt())
        val canvasHeight = (canvasWidth * 16f / 9f).toInt()
        if (surface.layoutParams?.width != canvasWidth || surface.layoutParams?.height != canvasHeight) {
            surface.layoutParams = LayoutParams(canvasWidth, canvasHeight, Gravity.CENTER)
        }
        if (geometryWidth != canvasWidth || geometryHeight != canvasHeight) {
            geometryWidth = canvasWidth; geometryHeight = canvasHeight
            arrange(canvasWidth, canvasHeight)
            updateIcons()
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }

    private fun arrange(w: Int, h: Int) {
        val unit = w / 100f
        place(brandTexture, 0f, 0f, w.toFloat(), h.toFloat())
        place(skin, 0f, 0f, w.toFloat(), h.toFloat())
        place(logo, w * .30f, h * .015f, w * .40f, h * .062f)
        val sw = w * .91f
        val sh = h * .868f
        place(stage, w * .045f, h * .092f, sw, sh)
        stage.background = rounded(Color.rgb(250, 249, 252), unit * 2.4f)
        val actionHeight = unit * 8.4f
        val gap = unit * 2
        place(actions, sw * .04f, sh * .955f - actionHeight, sw * .92f, actionHeight)
        primary.layoutParams = LinearLayout.LayoutParams((sw * .42f).toInt(), actionHeight.toInt())
        continueButton.layoutParams = LinearLayout.LayoutParams((sw * .32f).toInt(), actionHeight.toInt()).apply {
            leftMargin = gap.toInt()
        }
        primary.background = rounded(PURPLE, unit * 1.4f)
        continueButton.background = rounded(0xe6faf8ff.toInt(), unit * 1.4f).apply {
            setStroke(maxOf(1, (unit * .12f).toInt()), Color.rgb(217, 206, 237))
        }
        primary.setTextSize(TypedValue.COMPLEX_UNIT_PX, unit * 3.2f)
        continueButton.setTextSize(TypedValue.COMPLEX_UNIT_PX, unit * 2.5f)
        status.layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.RIGHT).apply {
            topMargin = (unit * 2).toInt(); rightMargin = (unit * 2).toInt()
        }
        status.maxWidth = (sw * .81f).toInt()
        status.background = rounded(0xe6faf8ff.toInt(), unit * 1.2f)
        status.setPadding((unit * 1.6f).toInt(), (unit * .8f).toInt(), (unit * 1.6f).toInt(), (unit * .8f).toInt())
        status.setTextSize(TypedValue.COMPLEX_UNIT_PX, unit * 2.4f)
        empty.setTextSize(TypedValue.COMPLEX_UNIT_PX, unit * 3.2f)
        pairTitle.setTextSize(TypedValue.COMPLEX_UNIT_PX, unit * 4)
        pairCode.setTextSize(TypedValue.COMPLEX_UNIT_PX, unit * 8)
        pairCode.layoutParams = LinearLayout.LayoutParams(-1, (unit * 16).toInt())
        pairingHint.setTextSize(TypedValue.COMPLEX_UNIT_PX, unit * 2.8f)
        pairing.background = rounded(Color.rgb(250, 249, 252), 0f)
        place(home, w * .045f, h * .96f, unit * 6, unit * 6)
        home.background = rounded(if (skinKey == "brand") 0x1fffffff else 0x80ffffff.toInt(), unit * 1.4f)
        place(settings, w * .93f, h * .02f, unit * 5, unit * 5)
        settings.background = rounded(0x33ffffff, unit * 1.4f)
    }

    private fun place(view: View, x: Float, y: Float, w: Float, h: Float) {
        val next = LayoutParams(w.toInt(), h.toInt()).apply { leftMargin = x.toInt(); topMargin = y.toInt() }
        val old = view.layoutParams as? LayoutParams
        if (old == null || old.width != next.width || old.height != next.height || old.leftMargin != next.leftMargin || old.topMargin != next.topMargin) view.layoutParams = next
    }

    private fun text(value: String, color: Int) = TextView(context).apply {
        text = value; gravity = Gravity.CENTER; setTextColor(color); includeFontPadding = false
    }
    private fun action(value: String, filled: Boolean) = Button(context).apply {
        text = value; isAllCaps = false; stateListAnimator = null; minimumHeight = 0; minimumWidth = 0
        minHeight = 0; minWidth = 0; setPadding(0, 0, 0, 0)
        setTextColor(if (filled) Color.WHITE else Color.rgb(119, 98, 145))
    }
    private fun rounded(color: Int, radius: Float) = GradientDrawable().apply { setColor(color); cornerRadius = radius }
    companion object {
        val PURPLE: Int = Color.rgb(112, 99, 208)
        val INK: Int = Color.rgb(64, 50, 123)
    }
}
