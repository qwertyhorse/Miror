package ai.xmax.sdk.foundation.rtc

import ai.xmax.sdk.RealtimeLocalVideoFrameListener
import ai.xmax.sdk.XmaxError
import ai.xmax.sdk.XmaxErrorCode
import android.os.SystemClock
import io.agora.base.VideoFrame

/** Uses the existing Agora capture; never opens another camera or keeps a borrowed frame. */
internal class AgoraCameraFrameProcessor(private val clock: () -> Long = { SystemClock.elapsedRealtime() }) {
    private val lock = Any()
    private var active = false
    private var generation = 0L
    private var sampleEpoch = 0L
    private var rotationDegrees = 0
    private var previousGeometry: CameraFrameGeometry? = null

    fun setRotation(degrees: Int) {
        if (degrees !in listOf(0, 90, 180, 270)) throw XmaxError(
            XmaxErrorCode.INVALID_CONFIGURATION, "Camera rotation must be 0, 90, 180, or 270 degrees",
        )
        synchronized(lock) { rotationDegrees = degrees }
    }

    fun start() = synchronized(lock) {
        generation++
        active = true
        previousGeometry = null
    }

    fun stop() = synchronized(lock) {
        generation++
        sampleEpoch++
        active = false
        previousGeometry = null
    }

    fun invalidateSamples() = synchronized(lock) { sampleEpoch++ }

    fun process(
        frame: VideoFrame,
        geometryListener: ((CameraFrameGeometry, Boolean) -> Unit)?,
        sampleListener: RealtimeLocalVideoFrameListener?,
        isCurrentListener: () -> Boolean = { true },
    ): Boolean {
        val state = synchronized(lock) {
            if (!active) return false
            Triple(generation, sampleEpoch, rotationDegrees)
        }
        val raw = CameraFrameGeometry(frame.buffer.width, frame.buffer.height, frame.rotation)
        if (!raw.isValid) return false
        if (state.third != 0) {
            // In READ_WRITE mode this metadata is returned to Agora, so preview and
            // encoder both consume the installation correction. replaceBuffer releases
            // the previous reference; retain before reusing the same native buffer.
            val buffer = frame.buffer
            buffer.retain()
            frame.replaceBuffer(buffer, (frame.rotation + state.third) % 360, frame.timestampNs)
        }
        val geometry = CameraFrameGeometry(frame.buffer.width, frame.buffer.height, frame.rotation)
        val changed = synchronized(lock) {
            if (!active || generation != state.first) return false
            val previous = previousGeometry
            previousGeometry = geometry
            (previous != geometry) to (previous == null)
        }
        if (changed.first) geometryListener?.invoke(geometry, changed.second)
        if (sampleListener == null || !isCurrentListener()) return true
        val timestamp = clock()
        if (!sampleListener.shouldCaptureFrame(timestamp)) return true
        try {
            // getMirrorApplied=false: the observer owns unmirrored pixels. Agora's
            // preview/encoder mirror settings stay independent of hand analysis.
            val sample = AgoraRemoteVideoFrame(frame).copy()
            val current = synchronized(lock) { active && generation == state.first && sampleEpoch == state.second }
            if (current && isCurrentListener()) sampleListener.onFrame(sample, timestamp)
            else sampleListener.onFrameDropped()
        } catch (_: Exception) {
            sampleListener.onFrameDropped()
        }
        return true
    }
}
