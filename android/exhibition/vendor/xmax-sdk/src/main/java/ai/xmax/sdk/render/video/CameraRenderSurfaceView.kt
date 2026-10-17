package ai.xmax.sdk.render.video

import android.content.Context
import android.view.SurfaceView

/** Local camera only. Keep the default below-window Z order so UI/remote video can cover it. */
internal class CameraRenderSurfaceView(context: Context) : SurfaceView(context) {
    private var fixedSize: VideoRenderSize? = null

    var maximumRenderPixels: Int = 0
        set(value) {
            require(value >= 0)
            if (field == value) return
            field = value
            updateBufferSize()
        }

    override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
        super.onSizeChanged(width, height, oldWidth, oldHeight)
        updateBufferSize()
    }

    private fun updateBufferSize() {
        if (maximumRenderPixels == 0) {
            if (fixedSize != null) {
                holder.setSizeFromLayout()
                fixedSize = null
            }
            return
        }
        if (width <= 0 || height <= 0) return
        val next = VideoRenderSize.limited(width, height, maximumRenderPixels)
        if (fixedSize == next) return
        // Resize the producer's buffer, never this View or its transparent window hole.
        holder.setFixedSize(next.width, next.height)
        fixedSize = next
    }
}
