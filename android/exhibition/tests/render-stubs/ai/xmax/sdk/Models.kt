package ai.xmax.sdk
import android.content.Context
enum class VideoContentMode { FIT, FILL }
class RealtimeVideoTrack(val id: String)
enum class VideoPixelFormat { RGBA }
class Format(val width: Int = 1, val height: Int = 1, val pixelFormat: VideoPixelFormat = VideoPixelFormat.RGBA)
class Plane { fun selectedBytesView() = byteArrayOf(0, 0, 0, 0) }
class VideoFrame(val format: Format = Format(), val planes: List<Plane> = listOf(Plane()))
interface TrajectoryEffectRendering
class DefaultTrajectoryEffectRenderer(context: Context) : TrajectoryEffectRendering
object ErrorMessageFormatter { fun format(error: Throwable) = error.toString() }
object XmaxLogger {
    val render = Log()
    fun localized(first: String, second: String) = second
    class Log { fun error(message: () -> String) { error(message()) } }
}
