package ai.openbuy.exhibition

import android.app.Dialog
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.RippleDrawable
import android.graphics.drawable.StateListDrawable
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlin.math.min

/** Presentation only: the Activity owns validation, preferences and camera leases. */
internal class NativeDeviceSettingsView(context: Context, remote: Boolean = false) : LinearLayout(context) {
    val address = MirrorSettingsStyle.input(context).apply {
        contentDescription = "展台网址"
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_TEXT_FLAG_MULTI_LINE
        setSingleLine(false)
        maxLines = 3
        gravity = Gravity.TOP or Gravity.START
    }
    val backendIp = MirrorSettingsStyle.input(context).apply {
        contentDescription = "备用 IP"
        hint = "自动发现"
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        setSingleLine(true)
    }
    val cameraContainer = LinearLayout(context).apply { orientation = VERTICAL }
    val meta = MirrorSettingsStyle.label(context, 12f)
    val cancelButton = MirrorSettingsStyle.button(context, "取消", false)
    val saveButton = MirrorSettingsStyle.button(context, "保存", true)

    init {
        orientation = VERTICAL
        background = MirrorUiTheme.rounded(Color.WHITE, dp(22).toFloat())
        clipToOutline = true
        isFocusableInTouchMode = true
        addView(MirrorSettingsStyle.label(context, 22f, primary = true).apply {
            text = if (remote) "摄像头检测" else "设备设置"
            typeface = MirrorUiTheme.typeface(600)
            setPadding(dp(24), dp(24), dp(24), dp(18))
            isAccessibilityHeading = true
        }, LayoutParams(-1, -2))

        val body = LinearLayout(context).apply {
            orientation = VERTICAL
            setPadding(dp(24), 0, dp(24), dp(8))
        }
        if (!remote) {
            body.addView(MirrorSettingsStyle.label(context).apply { text = "展台网址" })
            body.addView(address, LayoutParams(-1, -2).apply { topMargin = dp(8); bottomMargin = dp(18) })
            body.addView(MirrorSettingsStyle.label(context).apply { text = "备用 IP" })
            body.addView(backendIp, LayoutParams(-1, -2).apply { topMargin = dp(8); bottomMargin = dp(22) })
        }
        body.addView(cameraContainer, LayoutParams(-1, -2))
        body.addView(meta, LayoutParams(-1, -2).apply { topMargin = dp(18); bottomMargin = dp(8) })
        addView(ScrollView(context).apply {
            isFillViewport = false
            isVerticalScrollBarEnabled = false
            clipToPadding = false
            addView(body, LayoutParams(-1, -2))
        }, LayoutParams(-1, -2, 1f))

        addView(LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.END
            setPadding(dp(24), dp(16), dp(24), dp(22))
            background = ColorDrawable(Color.WHITE)
            addView(cancelButton, LayoutParams(0, dp(48), 1f))
            addView(saveButton, LayoutParams(0, dp(48), 1f).apply { leftMargin = dp(12) })
        }, LayoutParams(-1, -2))
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val cap = (resources.displayMetrics.heightPixels * .85f).toInt()
        val available = if (MeasureSpec.getMode(heightMeasureSpec) == MeasureSpec.UNSPECIFIED) cap
            else min(cap, MeasureSpec.getSize(heightMeasureSpec))
        super.onMeasure(widthMeasureSpec, MeasureSpec.makeMeasureSpec(available, MeasureSpec.AT_MOST))
    }

    private fun dp(value: Int) = MirrorUiTheme.dp(context, value.toFloat())
}

internal class MirrorSettingsDialog(context: Context, val content: NativeDeviceSettingsView) : Dialog(context) {
    init {
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        setContentView(content)
        setCanceledOnTouchOutside(false)
        window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            attributes = attributes.apply { dimAmount = .36f; gravity = Gravity.CENTER }
        }
    }

    override fun show() {
        super.show()
        window?.setLayout(min((context.resources.displayMetrics.widthPixels * .88f).toInt(),
            MirrorUiTheme.dp(context, 560f)), WindowManager.LayoutParams.WRAP_CONTENT)
        restoreImmersive()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) restoreImmersive()
    }

    @Suppress("DEPRECATION")
    private fun restoreImmersive() {
        window?.decorView?.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
    }
}

internal object MirrorSettingsStyle {
    val SECONDARY = Color.rgb(119, 98, 145)
    val BORDER = Color.rgb(221, 213, 241)
    val ERROR = Color.rgb(175, 60, 65)

    fun label(context: Context, size: Float = 13f, primary: Boolean = false) = TextView(context).apply {
        textSize = size
        setTextColor(if (primary) MirrorUiTheme.INK else SECONDARY)
        typeface = MirrorUiTheme.typeface(400)
        includeFontPadding = false
    }

    fun input(context: Context) = EditText(context).apply {
        textSize = 14f
        setTextColor(MirrorUiTheme.INK)
        setHintTextColor(SECONDARY)
        typeface = MirrorUiTheme.typeface(400)
        minimumHeight = MirrorUiTheme.dp(context, 48f)
        val horizontal = MirrorUiTheme.dp(context, 14f)
        val vertical = MirrorUiTheme.dp(context, 12f)
        setPadding(horizontal, vertical, horizontal, vertical)
        background = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), MirrorUiTheme.rounded(Color.WHITE,
                MirrorUiTheme.dp(context, 10f).toFloat(), MirrorUiTheme.PRIMARY, MirrorUiTheme.dp(context, 2f)))
            addState(intArrayOf(), MirrorUiTheme.rounded(Color.WHITE,
                MirrorUiTheme.dp(context, 10f).toFloat(), BORDER, MirrorUiTheme.dp(context, 1f)))
        }
    }

    fun button(context: Context, title: String, filled: Boolean) = MirrorActionButton(context, filled).apply {
        text = title
        textSize = 15f
        setTextColor(if (filled) Color.WHITE else SECONDARY)
        val shape = MirrorUiTheme.rounded(if (filled) MirrorUiTheme.PRIMARY else Color.WHITE,
            MirrorUiTheme.dp(context, 10f).toFloat(), if (filled) null else BORDER,
            MirrorUiTheme.dp(context, 1f))
        background = RippleDrawable(ColorStateList.valueOf(if (filled) 0x24ffffff else 0x167560db), shape, null)
        setPadding(MirrorUiTheme.dp(context, 14f), 0, MirrorUiTheme.dp(context, 14f), 0)
    }
}
