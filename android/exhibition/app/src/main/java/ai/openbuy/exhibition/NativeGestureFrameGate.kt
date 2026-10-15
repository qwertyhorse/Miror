package ai.openbuy.exhibition

/** Single in-flight evaluation; invalidating a boundary never queues another frame. */
internal class NativeGestureFrameGate {
    data class Ticket(val serial: Long, val epoch: Long)
    private var epoch = 0L
    private var serial = 0L
    private var pending: Ticket? = null
    private var latestTimestamp = -1L
    private var closed = false

    fun begin(timestampMs: Long): Ticket? {
        if (closed || pending != null || timestampMs < 0 || timestampMs <= latestTimestamp) return null
        latestTimestamp = timestampMs
        return Ticket(++serial, epoch).also { pending = it }
    }

    fun complete(ticket: Ticket): Boolean {
        if (pending != ticket) return false
        pending = null
        return !closed && ticket.epoch == epoch
    }

    fun invalidate(resetTimestamp: Boolean = false) {
        epoch++
        if (resetTimestamp) latestTimestamp = -1L
    }

    fun close() {
        closed = true
        invalidate()
    }
}
