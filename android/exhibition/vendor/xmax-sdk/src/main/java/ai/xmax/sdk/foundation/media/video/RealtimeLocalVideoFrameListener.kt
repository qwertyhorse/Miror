package ai.xmax.sdk

/** Observes copied camera pixels before encoding. No second camera is opened. */
public interface RealtimeLocalVideoFrameListener {
    /** Called on the capture thread before copying; false drops this frame. */
    public fun shouldCaptureFrame(timestampMs: Long): Boolean = true
    /** Pixels are owned by this value and may be processed asynchronously. */
    public fun onFrame(frame: RealtimeVideoFrame, timestampMs: Long)
    /** Releases a reservation made by shouldCaptureFrame when copying fails. */
    public fun onFrameDropped() {}
}
