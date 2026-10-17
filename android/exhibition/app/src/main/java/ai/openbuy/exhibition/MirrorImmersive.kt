package ai.openbuy.exhibition

import android.os.Build
import android.view.View
import android.view.Window
import android.view.WindowInsets
import android.view.WindowInsetsController

/** Reassert after a permission dialog, application resume, or settings dismissal. */
internal object MirrorImmersive {
    @JvmStatic
    @Suppress("DEPRECATION")
    fun apply(window: Window) {
        // Android 11's Window.getInsetsController() dereferences an uncreated decor.
        // The native screen applies immersive mode before setContentView().
        val decor = window.decorView
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
            val controller = decor.windowInsetsController
            if (controller != null) {
                controller.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                controller.hide(WindowInsets.Type.systemBars())
                return
            }
        }
        // Before attachment there may be no controller; resume/focus reapplies it.
        decor.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
    }
}
