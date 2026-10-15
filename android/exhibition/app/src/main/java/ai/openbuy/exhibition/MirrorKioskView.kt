package ai.openbuy.exhibition

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import ai.xmax.sdk.VideoContentMode
import ai.xmax.sdk.XmaxRealtimeVideoView
import kotlin.math.roundToInt

/** Native equivalent of mirror-screen.css. All geometry scales with the 9:16 canvas. */
internal class MirrorKioskView(context: Context) : FrameLayout(context) {
    val surface = FrameLayout(context)
    val skin = ImageView(context).apply { scaleType = ImageView.ScaleType.FIT_XY }
    private val brandTexture = ImageView(context).apply {
        scaleType = ImageView.ScaleType.FIT_XY; setImageResource(R.drawable.mirror_brand_texture)
    }
    private val logoSource = requireNotNull(BitmapFactory.decodeResource(context.resources, R.drawable.mirror_logo,
        BitmapFactory.Options().apply { inScaled = false; inPreferredConfig = Bitmap.Config.ARGB_8888 }))
    val logo = ImageView(context).apply {
        scaleType = ImageView.ScaleType.FIT_CENTER; setImageBitmap(logoSource)
        (drawable as? BitmapDrawable)?.apply { isFilterBitmap = true; setAntiAlias(true) }
        contentDescription = "OpenBuyAI"
    }
    val stage = FrameLayout(context).apply { clipToOutline = true }
    val video = XmaxRealtimeVideoView(context).apply {
        videoContentMode = VideoContentMode.FILL; isInteractionEnabled = false
    }
    val poster = ImageView(context).apply {
        scaleType = ImageView.ScaleType.FIT_CENTER
        setBackgroundColor(MirrorUiTheme.SURFACE)
        visibility = GONE
    }
    val empty = text("暂无可用素材", Color.rgb(145, 134, 172))
    val pairing = NativePairingView(context)
    val pairTitle = pairing.title
    val pairCode = pairing.code
    val drawer = MirrorMaterialDrawerView(context)
    val status = text("连接后台…", Color.rgb(99, 83, 127)).apply { maxLines = 3 }
    val primary = MirrorActionButton(context).apply { text = "开始体验" }
    val continueButton = MirrorActionButton(context, false).apply { text = "继续体验"; visibility = GONE }
    private val actions = LinearLayout(context).apply { gravity = Gravity.CENTER }
    val home = MirrorActionButton(context, false).apply {
        contentDescription = "返回首页"; visibility = GONE
    }
    val gestures = text("", Color.rgb(99, 83, 127)).apply {
        visibility = GONE
        isClickable = true
        isFocusable = true
        contentDescription = "手势识别"
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
        stage.addView(pairing, LayoutParams(-1, -1))
        stage.addView(status)
        // Like the web drawer, this occupies the stage without consuming the video's space.
        stage.addView(drawer, LayoutParams(-1, -1))
        actions.addView(primary)
        actions.addView(continueButton)
        stage.addView(actions)
        surface.addView(home)
        surface.addView(gestures)
    }

    fun applySkin(preset: String, custom: Boolean) {
        val key = if (custom) "custom" else preset
        if (skinKey == key) return
        skinKey = key
        skin.tag = null
        skin.alpha = 1f
        when (key) {
            "brand" -> {
                surface.setBackgroundColor(MirrorUiTheme.BRAND)
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
        home.background = MirrorUiTheme.rounded(if (key == "brand") 0x1fffffff else 0x80ffffff.toInt(), width * .014f)
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
        primary.setIcon(primaryIcon, (unit * 3.5f).toInt(), Color.WHITE, (unit * 1.5f).toInt())
        continueButton.setIcon(R.drawable.mirror_resume, (unit * 2.8f).toInt(), gapPx = unit.toInt())
        home.setIcon(R.drawable.mirror_home, (unit * 3.4f).toInt(), if (skinKey == "brand") Color.WHITE else Color.rgb(121, 102, 188))
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
        // Match the web image's width:100%, height:auto. The source includes transparent
        // padding, so constraining it to the header height visibly shrinks the wordmark.
        val logoWidth = w * .40f
        val logoHeight = logoWidth * logoSource.height / logoSource.width
        val logoCenterY = h * (.015f + .062f / 2f)
        place(logo, w * .30f, logoCenterY - logoHeight / 2f, logoWidth, logoHeight)
        renderLogo(logoWidth.toInt(), logoHeight.toInt())
        val sw = w * .91f
        val sh = h * .868f
        place(stage, w * .045f, h * .092f, sw, sh)
        stage.background = MirrorUiTheme.rounded(MirrorUiTheme.SURFACE, unit * 2.4f)
        val actionHeight = unit * 8.4f
        val gap = unit * 2
        place(actions, sw * .04f, sh * .955f - actionHeight, sw * .92f, actionHeight)
        primary.minimumWidth = (sw * .92f * .42f).toInt()
        primary.minWidth = primary.minimumWidth
        primary.layoutParams = LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, actionHeight.toInt())
        continueButton.layoutParams = LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, actionHeight.toInt()).apply {
            leftMargin = gap.toInt()
        }
        primary.background = MirrorUiTheme.rounded(MirrorUiTheme.PRIMARY, unit * 1.4f)
        continueButton.background = MirrorUiTheme.rounded(0xe6faf8ff.toInt(), unit * 1.4f).apply {
            setStroke(maxOf(1, (unit * .12f).toInt()), Color.rgb(217, 206, 237))
        }
        primary.setTextSize(TypedValue.COMPLEX_UNIT_PX, unit * 3.2f)
        continueButton.setTextSize(TypedValue.COMPLEX_UNIT_PX, unit * 2.5f)
        status.layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.RIGHT).apply {
            topMargin = (unit * 2).toInt(); rightMargin = (unit * 2).toInt()
        }
        status.maxWidth = (sw * .81f).toInt()
        status.background = MirrorUiTheme.rounded(0xe6faf8ff.toInt(), unit * 1.2f)
        status.setPadding((unit * 1.6f).toInt(), (unit * .8f).toInt(), (unit * 1.6f).toInt(), (unit * .8f).toInt())
        status.setTextSize(TypedValue.COMPLEX_UNIT_PX, unit * 2.4f)
        empty.setTextSize(TypedValue.COMPLEX_UNIT_PX, unit * 3.2f)
        pairing.arrange(sw)
        place(home, w * .045f, h * .96f, unit * 6, unit * 6)
        place(gestures, w * .25f, h * .96f, w * .5f, unit * 6)
        gestures.setTextSize(TypedValue.COMPLEX_UNIT_PX, unit * 2.4f)
        home.background = MirrorUiTheme.rounded(if (skinKey == "brand") 0x1fffffff else 0x80ffffff.toInt(), unit * 1.4f)
    }

    private fun renderLogo(width: Int, height: Int) {
        if (width <= 0 || height <= 0) return
        val scale = minOf(width.toFloat() / logoSource.width, height.toFloat() / logoSource.height, 1f)
        val targetWidth = (logoSource.width * scale).roundToInt().coerceAtLeast(1)
        val targetHeight = (logoSource.height * scale).roundToInt().coerceAtLeast(1)
        // The original web asset is 2481px wide. A single GPU bilinear reduction to the
        // 40%-width logo samples too few source pixels and aliases its alpha edges, even
        // with filterBitmap enabled. Prefilter in <=2x steps before the final display size.
        var filtered = logoSource
        while (filtered.width > targetWidth * 2 || filtered.height > targetHeight * 2) {
            val next = Bitmap.createScaledBitmap(filtered,
                maxOf(targetWidth, filtered.width / 2), maxOf(targetHeight, filtered.height / 2), true)
            if (filtered !== logoSource) filtered.recycle()
            filtered = next
        }
        if (filtered.width != targetWidth || filtered.height != targetHeight) {
            val next = Bitmap.createScaledBitmap(filtered, targetWidth, targetHeight, true)
            if (filtered !== logoSource) filtered.recycle()
            filtered = next
        }
        if (filtered !== logoSource) filtered.density = Bitmap.DENSITY_NONE
        logo.setImageBitmap(filtered)
        (logo.drawable as? BitmapDrawable)?.apply { isFilterBitmap = true; setAntiAlias(true) }
    }

    private fun place(view: View, x: Float, y: Float, w: Float, h: Float) {
        val next = LayoutParams(w.toInt(), h.toInt()).apply { leftMargin = x.toInt(); topMargin = y.toInt() }
        val old = view.layoutParams as? LayoutParams
        if (old == null || old.width != next.width || old.height != next.height || old.leftMargin != next.leftMargin || old.topMargin != next.topMargin) view.layoutParams = next
    }

    private fun text(value: String, color: Int) = TextView(context).apply {
        text = value; gravity = Gravity.CENTER; setTextColor(color); includeFontPadding = false
    }
    companion object {
        val PURPLE: Int = MirrorUiTheme.BRAND
        val INK: Int = MirrorUiTheme.INK
    }
}
