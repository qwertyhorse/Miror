package ai.openbuy.exhibition

/** Only a new/reconfigured recognizer uses this fence; normal gesture timing stays in the shared detector. */
internal class NativeGestureReleaseFence {
    var required = true
        private set
    private var emptySince: Long? = null
    private var lastEmpty: Long? = null

    fun reset() { required = true; emptySince = null; lastEmpty = null }

    /** Returns true once release becomes safe. Slow, still-fresh samples must not permanently lock an old device. */
    fun observe(timestamp: Long, empty: Boolean): Boolean {
        if (!required) return false
        if (!empty) { emptySince = null; lastEmpty = null; return false }
        val last = lastEmpty
        if (last == null || timestamp <= last || timestamp - last >= 800) emptySince = timestamp
        lastEmpty = timestamp
        if (timestamp - (emptySince ?: timestamp) < 500) return false
        required = false
        return true
    }
}
