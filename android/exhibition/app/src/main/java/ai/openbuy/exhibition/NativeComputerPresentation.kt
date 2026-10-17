package ai.openbuy.exhibition

/** Page pixels already contain the complete UI and its camera orientation. */
internal data class NativeComputerPresentation private constructor(
    val source: String,
    val mirrored: Boolean,
    val rotation: Int,
    val active: Boolean,
    val presentationId: Long?,
) {
    val isPage get() = source == "page"
    val isImage get() = source == "image"

    fun showFullPage(sessionPresent: Boolean, videoReady: Boolean, backendHealthy: Boolean) =
        isPage && active && sessionPresent && videoReady && backendHealthy

    companion object {
        fun from(source: String = "camera", mirrored: Boolean = false, rotation: Int = 0,
            active: Boolean = false, presentationId: Long? = null): NativeComputerPresentation {
            val mode = source.takeIf { it in setOf("camera", "output", "image", "page") } ?: "camera"
            return NativeComputerPresentation(mode, mode != "page" && mirrored,
                if (mode == "page" || rotation !in setOf(0, 90, 180, 270)) 0 else rotation,
                mode != "page" || active,
                presentationId?.takeIf { mode == "page" && it in 0..9_007_199_254_740_991L })
        }
    }
}
