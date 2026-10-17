package ai.xmax.sdk.render.video

import kotlin.math.sqrt

/** Surface dimensions only; capture, encoding and interaction coordinates stay unchanged. */
internal data class VideoRenderSize(val width: Int, val height: Int) {
    companion object {
        fun limited(width: Int, height: Int, maximumPixels: Int): VideoRenderSize {
            require(width >= 0 && height >= 0 && maximumPixels >= 0)
            val pixels = width.toLong() * height
            if (maximumPixels == 0 || pixels <= maximumPixels) return VideoRenderSize(width, height)

            val scale = sqrt(maximumPixels.toDouble() / pixels)
            var renderWidth = (width * scale).toInt().coerceAtLeast(1)
            var renderHeight = (height * scale).toInt().coerceAtLeast(1)
            // A one-pixel short edge can otherwise exceed the cap for very thin views.
            if (renderWidth.toLong() * renderHeight > maximumPixels) {
                if (renderWidth >= renderHeight) renderWidth = maximumPixels / renderHeight
                else renderHeight = maximumPixels / renderWidth
            }
            return VideoRenderSize(renderWidth, renderHeight)
        }
    }
}
