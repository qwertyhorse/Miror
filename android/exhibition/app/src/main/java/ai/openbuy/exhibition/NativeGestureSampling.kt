package ai.openbuy.exhibition

/** Only controls the analysis copy, never RTC capture or XMAX encoding. */
internal data class NativeGestureSampling(val maxFps: Int, val inputLongEdge: Int) {
    val intervalMs: Long get() = (1_000L + maxFps - 1) / maxFps

    companion object {
        val LOCAL = NativeGestureSampling(10, 640)
        fun linux(maxFps: Int = 15, inputLongEdge: Int = 720) = NativeGestureSampling(
            maxFps.coerceIn(5, 30), inputLongEdge.takeIf { it in listOf(480, 720, 960) } ?: 720)
    }
}
