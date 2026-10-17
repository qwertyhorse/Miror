package android.widget
import android.content.Context
import android.view.ViewGroup
open class FrameLayout(context: Context) : ViewGroup(context) {
    class LayoutParams(val width: Int, val height: Int) { companion object { const val MATCH_PARENT = -1 } }
}
