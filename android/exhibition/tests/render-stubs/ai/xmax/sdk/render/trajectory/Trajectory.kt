package ai.xmax.sdk.render.trajectory
import ai.xmax.sdk.RealtimeVideoTrack
import ai.xmax.sdk.TrajectoryEffectRendering
import ai.xmax.sdk.VideoContentMode
import android.content.Context
import android.view.View
class TrajectoryOverlayView(context: Context) : View(context) {
    fun setRequestedInteractionEnabled(value: Boolean) {}
    fun setRenderer(value: TrajectoryEffectRendering) {}
}
class TrajectoryBinding {
    fun attach(view: TrajectoryOverlayView, mode: VideoContentMode) {}
    fun detach(view: TrajectoryOverlayView) {}
}
object TrajectoryRegistry { fun binding(track: RealtimeVideoTrack): TrajectoryBinding? = null }
