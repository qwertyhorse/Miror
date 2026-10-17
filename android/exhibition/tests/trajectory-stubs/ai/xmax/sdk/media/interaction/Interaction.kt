package ai.xmax.sdk.media.interaction
import ai.xmax.sdk.RealtimeVideoFormat
import ai.xmax.sdk.VideoContentMode
import android.graphics.PointF
import android.graphics.RectF
import android.util.SizeF
class InteractionFrame(val points: List<PointF>, val viewportSize: SizeF, val contentMode: VideoContentMode, val displayedVideoFormat: RealtimeVideoFormat?)
object InteractionCoordinateMapper {
    fun displayedFrame(viewportSize: SizeF, videoSize: SizeF, contentMode: VideoContentMode): RectF? =
        if (viewportSize.width <= 0 || viewportSize.height <= 0 || videoSize.width <= 0 || videoSize.height <= 0) null
        else RectF(0f, 0f, viewportSize.width, viewportSize.height)
}
