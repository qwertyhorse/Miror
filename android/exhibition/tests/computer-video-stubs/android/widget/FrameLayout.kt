package android.widget
import android.content.Context
import android.view.View

class FrameLayout(context: Context) : View(context) {
    val children = mutableListOf<View>()
    class LayoutParams(val width: Int, val height: Int) { companion object { const val MATCH_PARENT = -1 } }
    fun addView(view: View, params: LayoutParams) { children += view }
    fun removeView(view: View) { children -= view }
}
