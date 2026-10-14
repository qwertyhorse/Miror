package ai.openbuy.exhibition

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.text.TextUtils
import android.util.TypedValue
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.roundToInt

/** Native counterpart of MirrorMaterialDrawer.tsx, sized in the stage's container units. */
internal class MirrorMaterialDrawerView(context: Context) : FrameLayout(context) {
    var onSelect: ((String) -> Unit)? = null
    var bindImage: ((ImageView, String) -> Unit)? = null
        set(value) {
            field = value
            bindImages()
        }

    val isOpen: Boolean get() = opened
    private var opened = false
    private var columns = 2
    private var selectedId = ""
    private var selectionEnabled = true
    private var drawerTitle = "选择款式"
    private var unit = 1f
    private var items = emptyList<Material>()
    private var contentRevision = 0L
    private var appliedGeometry: Geometry? = null
    private var appliedRows: RowGeometry? = null
    private var scrollAfterLayout = false
    private val cards = linkedMapOf<String, MaterialCard>()
    private val panel = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        isClickable = true
        visibility = View.GONE
        outlineAmbientShadowColor = Color.parseColor("#143e2852")
        outlineSpotShadowColor = Color.parseColor("#143e2852")
    }
    private val heading = TextView(context).apply {
        setTextColor(Color.parseColor("#66587d"))
        typeface = MirrorUiTheme.typeface()
        includeFontPadding = false
        maxLines = 2
        ellipsize = TextUtils.TruncateAt.END
        isAccessibilityHeading = true
    }
    private val grid = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private val scroll = ScrollView(context).apply {
        isFillViewport = false
        isHorizontalScrollBarEnabled = false
        isVerticalScrollBarEnabled = true
        overScrollMode = View.OVER_SCROLL_NEVER
        clipToPadding = false
        addView(grid, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    }
    private val toggle = DrawerHandle(context).apply {
        isClickable = true
        isFocusable = true
        setOnClickListener { setOpen(!opened) }
    }

    init {
        // Only the small handle and, when open, the panel consume stage touches.
        isClickable = false
        isFocusable = false
        clipChildren = false
        clipToPadding = false
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        panel.addView(heading, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        panel.addView(scroll, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))
        addView(panel)
        addView(toggle)
        updateToggle()
    }

    fun submit(looks: List<JSONObject>, selectedId: String, columns: Int, enabled: Boolean, title: String) {
        val next = looks.map {
            Material(it.optString("id"), it.optString("name"), it.optString("image"))
        }.filter { it.id.isNotEmpty() }.distinctBy { it.id }
        val columnCount = if (columns == 1) 1 else 2
        val structureChanged = next != items || columnCount != this.columns
        val selectionChanged = selectedId != this.selectedId
        this.columns = columnCount
        this.selectedId = selectedId
        selectionEnabled = enabled
        drawerTitle = title
        heading.text = title
        updateToggle()
        if (structureChanged) {
            items = next
            val retained = next.map { it.id }.toSet()
            cards.keys.filter { it !in retained }.forEach { cards.remove(it) }
            for (item in next) {
                val card = cards.getOrPut(item.id) {
                    MaterialCard(context).apply {
                        setOnClickListener {
                            if (selectionEnabled && item.id != this@MirrorMaterialDrawerView.selectedId) {
                                onSelect?.invoke(item.id)
                            }
                        }
                    }
                }
                card.contentDescription = "选择${item.name}"
            }
            contentRevision++
            invalidateGeometry()
        }
        for (item in items) cards[item.id]?.apply {
            isEnabled = enabled
            isSelected = item.id == selectedId
            invalidate()
        }
        bindImages()
        if (opened && (selectionChanged || structureChanged)) {
            scrollAfterLayout = true
            requestLayout()
        }
    }

    fun setOpen(open: Boolean) {
        if (opened == open) return
        opened = open
        panel.visibility = if (open) View.VISIBLE else View.GONE
        updateToggle()
        scrollAfterLayout = open
        invalidateGeometry()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        // Set child sizes before FrameLayout measures them, including the very first frame.
        applyGeometry(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec))
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        if (opened && scrollAfterLayout) {
            scrollAfterLayout = false
            scrollSelectedIntoView()
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (opened && event.keyCode == KeyEvent.KEYCODE_ESCAPE && event.action == KeyEvent.ACTION_UP) {
            setOpen(false)
            toggle.requestFocus()
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun updateToggle() {
        toggle.opened = opened
        toggle.contentDescription = if (opened) "收起素材选择" else drawerTitle
        toggle.invalidate()
    }

    private fun bindImages() {
        val binder = bindImage ?: return
        for (item in items) cards[item.id]?.let { binder(it.image, item.image) }
    }

    private fun invalidateGeometry() {
        appliedGeometry = null
        requestLayout()
    }

    private fun applyGeometry(stageWidth: Int, stageHeight: Int) {
        if (stageWidth <= 0 || stageHeight <= 0) return
        val geometry = Geometry(stageWidth, stageHeight, columns, opened, contentRevision)
        if (appliedGeometry == geometry) return
        appliedGeometry = geometry
        // CSS cqi is based on the outer canvas; the stage occupies 91% of it.
        unit = stageWidth / .91f / 100f
        val panelWidth = (stageWidth * if (columns == 1) .18f else .32f).roundToInt()
        val panelHeight = (stageHeight * .70f).roundToInt()
        val panelLeft = (stageWidth * .026f).roundToInt()
        panel.layoutParams = LayoutParams(panelWidth, panelHeight).apply {
            leftMargin = panelLeft
            topMargin = (stageHeight * .15f).roundToInt()
        }
        val padding = px(1.7f)
        panel.setPadding(padding, padding, padding, padding)
        panel.background = MirrorUiTheme.rounded(0xe6faf8ff.toInt(), unit * 2f, 0xcce4dcef.toInt())
        panel.elevation = unit
        heading.setTextSize(TypedValue.COMPLEX_UNIT_PX, unit * 2.35f)
        heading.setLineSpacing(0f, 1.3f)
        (heading.layoutParams as LinearLayout.LayoutParams).apply { bottomMargin = px(1.2f) }
        val scrollPadding = px(.3f)
        scroll.setPadding(scrollPadding, scrollPadding, scrollPadding, scrollPadding)
        val handleWidth = px(4.3f)
        val handleHeight = px(15f)
        toggle.unit = unit
        toggle.layoutParams = LayoutParams(handleWidth, handleHeight).apply {
            leftMargin = if (opened) panelLeft + panelWidth else 0
            topMargin = ((stageHeight - handleHeight) / 2f).roundToInt()
        }
        toggle.invalidate()
        val rows = RowGeometry(stageWidth, max(1, panelWidth - 2 * padding - 2 * scrollPadding), columns, contentRevision)
        if (appliedRows != rows) {
            appliedRows = rows
            rebuildRows(rows.availableWidth)
        }
    }

    private fun rebuildRows(availableWidth: Int) {
        grid.removeAllViews()
        val gap = px(1f)
        val cardWidth = max(1, (availableWidth - gap * (columns - 1)) / columns)
        val cardHeight = (cardWidth * 5f / 3f).roundToInt()
        items.chunked(columns).forEachIndexed { rowIndex, rowItems ->
            val row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
            grid.addView(row, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, cardHeight).apply {
                if (rowIndex > 0) topMargin = gap
            })
            rowItems.forEachIndexed { column, item ->
                val card = cards.getValue(item.id)
                (card.parent as? ViewGroup)?.removeView(card)
                card.unit = unit
                card.background = MirrorUiTheme.rounded(Color.WHITE, unit * 1.2f)
                row.addView(card, LinearLayout.LayoutParams(cardWidth, cardHeight).apply {
                    if (column > 0) leftMargin = gap
                })
            }
        }
    }

    private fun scrollSelectedIntoView() {
        cards[selectedId]?.let { card ->
            if (card.width > 0 && card.height > 0) {
                card.requestRectangleOnScreen(Rect(0, 0, card.width, card.height), true)
            }
        }
    }

    private fun px(value: Float) = max(1, (value * unit).roundToInt())

    private data class Material(val id: String, val name: String, val image: String)
    private data class Geometry(val width: Int, val height: Int, val columns: Int, val opened: Boolean, val revision: Long)
    private data class RowGeometry(val stageWidth: Int, val availableWidth: Int, val columns: Int, val revision: Long)

    private class MaterialCard(context: Context) : FrameLayout(context) {
        var unit = 1f
        val image = ImageView(context).apply {
            scaleType = ImageView.ScaleType.FIT_CENTER
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            isClickable = false
            isFocusable = false
        }
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        private val path = Path()

        init {
            isClickable = true
            isFocusable = true
            clipToOutline = true
            addView(image, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        }

        override fun dispatchDraw(canvas: Canvas) {
            super.dispatchDraw(canvas)
            if (!isSelected && !isFocused && !isHovered) return
            // The web selection adds a .25cqi translucent ring around its 2px border.
            // Keep the ring inside the native card outline so it stays visible at scroll edges.
            if (isSelected) {
                paint.style = Paint.Style.STROKE
                paint.strokeWidth = .5f * unit + 2f
                paint.color = 0x80b99bff.toInt()
                canvas.drawRoundRect(RectF(1f, 1f, width - 1f, height - 1f), 1.2f * unit, 1.2f * unit, paint)
            }
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = 2f
            paint.color = Color.parseColor(if (isSelected) "#b99bff" else "#d7c6fa")
            canvas.drawRoundRect(RectF(1f, 1f, width - 1f, height - 1f), 1.2f * unit, 1.2f * unit, paint)
            if (!isSelected) return
            val diameter = 2.8f * unit
            val centerX = width - .5f * unit - diameter / 2f
            val centerY = height - .5f * unit - diameter / 2f
            paint.style = Paint.Style.FILL
            paint.color = Color.parseColor("#9672e4")
            canvas.drawCircle(centerX, centerY, diameter / 2f, paint)
            val scale = 1.8f * unit / 24f
            canvas.save()
            canvas.translate(centerX - 12f * scale, centerY - 12f * scale)
            canvas.scale(scale, scale)
            // lucide-react v1.49.0, check: M20 6 9 17l-5-5 (ISC).
            path.reset()
            path.moveTo(20f, 6f)
            path.lineTo(9f, 17f)
            path.lineTo(4f, 12f)
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = 3f
            paint.strokeCap = Paint.Cap.ROUND
            paint.strokeJoin = Paint.Join.ROUND
            paint.color = Color.WHITE
            canvas.drawPath(path, paint)
            canvas.restore()
        }
    }

    private class DrawerHandle(context: Context) : View(context) {
        var unit = 1f
        var opened = false
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        private val path = Path()

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val radius = 1.6f * unit
            val right = width - .5f
            val bottom = height - .5f
            path.reset()
            path.addRoundRect(RectF(0f, .5f, right, bottom),
                floatArrayOf(0f, 0f, radius, radius, radius, radius, 0f, 0f), Path.Direction.CW)
            paint.style = Paint.Style.FILL
            paint.color = Color.parseColor("#e0faf8ff")
            canvas.drawPath(path, paint)
            path.reset()
            path.moveTo(0f, .5f)
            path.lineTo(right - radius, .5f)
            path.quadTo(right, .5f, right, radius)
            path.lineTo(right, bottom - radius)
            path.quadTo(right, bottom, right - radius, bottom)
            path.lineTo(0f, bottom)
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = 1f
            paint.color = Color.parseColor(if (isFocused) "#9672e4" else "#cce4dcef")
            canvas.drawPath(path, paint)
            val scale = 3.3f * unit / 24f
            canvas.save()
            canvas.translate(width / 2f - 12f * scale, height / 2f - 12f * scale)
            canvas.scale(scale, scale)
            // lucide-react v1.49.0, chevron-left/right (ISC), 24 × 24 viewBox.
            path.reset()
            path.moveTo(if (opened) 15f else 9f, 18f)
            path.lineTo(if (opened) 9f else 15f, 12f)
            path.lineTo(if (opened) 15f else 9f, 6f)
            paint.strokeWidth = 1.8f
            paint.strokeCap = Paint.Cap.ROUND
            paint.strokeJoin = Paint.Join.ROUND
            paint.color = Color.parseColor("#8068b1")
            canvas.drawPath(path, paint)
            canvas.restore()
        }
    }
}
