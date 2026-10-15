package ai.openbuy.exhibition

import android.content.Context
import android.graphics.Color
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView

/** Shared camera controls; this view never opens a camera or starts a session. */
internal open class NativeCameraSettingsView(context: Context) : LinearLayout(context) {
    val spinner = Spinner(context, Spinner.MODE_DROPDOWN).apply {
        background = null
        contentDescription = "选择摄像头"
        setPadding(0, 0, 0, 0)
        setPopupBackgroundDrawable(MirrorUiTheme.rounded(Color.WHITE, dp(10).toFloat(), MirrorSettingsStyle.BORDER, dp(1)))
    }
    val refresh = MirrorSettingsStyle.button(context, "重新检测", false).apply {
        setIcon(R.drawable.mirror_recover, dp(18), MirrorUiTheme.PRIMARY, dp(6))
        textSize = 13f
    }
    val rotationSpinner = Spinner(context, Spinner.MODE_DROPDOWN).apply {
        contentDescription = "画面方向"
        background = null
        setPadding(0, 0, 0, 0)
        setPopupBackgroundDrawable(MirrorUiTheme.rounded(Color.WHITE, dp(10).toFloat(), MirrorSettingsStyle.BORDER, dp(1)))
    }
    val feedback = MirrorSettingsStyle.label(context).apply { setPadding(0, dp(10), 0, dp(10)) }
    val previewContainer: FrameLayout = object : FrameLayout(context) {
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val width = MeasureSpec.getSize(widthMeasureSpec)
            super.onMeasure(widthMeasureSpec, MeasureSpec.makeMeasureSpec(width * 3 / 4, MeasureSpec.EXACTLY))
        }
    }.apply {
        background = MirrorUiTheme.rounded(Color.BLACK, dp(12).toFloat())
        clipToOutline = true
        visibility = View.GONE
    }

    init {
        orientation = VERTICAL
        addView(MirrorSettingsStyle.label(context).apply { text = "摄像头" })
        addView(LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(FrameLayout(context).apply {
                background = MirrorUiTheme.rounded(Color.WHITE, dp(10).toFloat(), MirrorSettingsStyle.BORDER, dp(1))
                addView(spinner, FrameLayout.LayoutParams(-1, -1))
                addView(ImageView(context).apply {
                    setImageResource(R.drawable.mirror_chevron_down)
                    imageTintList = android.content.res.ColorStateList.valueOf(MirrorSettingsStyle.SECONDARY)
                    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                    isClickable = false
                }, FrameLayout.LayoutParams(dp(18), dp(18), Gravity.END or Gravity.CENTER_VERTICAL).apply { rightMargin = dp(12) })
            }, LayoutParams(0, dp(48), 1f))
            addView(refresh, LayoutParams(dp(116), dp(48)).apply { leftMargin = dp(10) })
        }, LayoutParams(-1, -2).apply { topMargin = dp(8) })
        addView(MirrorSettingsStyle.label(context).apply { text = "画面方向" },
            LayoutParams(-1, -2).apply { topMargin = dp(16); bottomMargin = dp(8) })
        rotationSpinner.adapter = choicesAdapter(listOf("默认", "顺时针 90°", "旋转 180°", "逆时针 90°"))
        addView(FrameLayout(context).apply {
            background = MirrorUiTheme.rounded(Color.WHITE, dp(10).toFloat(), MirrorSettingsStyle.BORDER, dp(1))
            addView(rotationSpinner, FrameLayout.LayoutParams(-1, -1))
            addView(ImageView(context).apply {
                setImageResource(R.drawable.mirror_chevron_down)
                imageTintList = android.content.res.ColorStateList.valueOf(MirrorSettingsStyle.SECONDARY)
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                isClickable = false
            }, FrameLayout.LayoutParams(dp(18), dp(18), Gravity.END or Gravity.CENTER_VERTICAL).apply { rightMargin = dp(12) })
        }, LayoutParams(-1, dp(48)))
        addView(feedback, LayoutParams(-1, -2))
        addView(previewContainer, LayoutParams(-1, -2))
    }

    fun setChoices(labels: List<String>) {
        spinner.adapter = choicesAdapter(labels)
    }

    private fun choicesAdapter(labels: List<String>) =
        object : ArrayAdapter<String>(context, android.R.layout.simple_spinner_item, labels) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View = row(position, convertView, false)
            override fun getDropDownView(position: Int, convertView: View?, parent: ViewGroup): View = row(position, convertView, true)

            private fun row(position: Int, recycled: View?, dropdown: Boolean): TextView =
                ((recycled as? TextView) ?: MirrorSettingsStyle.label(context, 14f, primary = true)).apply {
                    text = getItem(position)
                    gravity = Gravity.CENTER_VERTICAL
                    setSingleLine(true)
                    ellipsize = TextUtils.TruncateAt.END
                    minHeight = dp(48)
                    setPadding(dp(14), dp(8), dp(if (dropdown) 14 else 36), dp(8))
                }
        }

    fun showMessage(text: String, failed: Boolean = false) {
        feedback.text = text
        feedback.setTextColor(if (failed) MirrorSettingsStyle.ERROR else MirrorSettingsStyle.SECONDARY)
        feedback.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    }

    private fun dp(value: Int) = MirrorUiTheme.dp(context, value.toFloat())
}
