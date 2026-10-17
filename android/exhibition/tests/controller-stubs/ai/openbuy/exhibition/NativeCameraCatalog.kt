package ai.openbuy.exhibition

import android.content.Context

/** Only the hardware catalog is replaced; merging and choosing metadata run in production code. */
internal class NativeCameraCatalog(@Suppress("UNUSED_PARAMETER") context: Context) {
    fun snapshot(): NativeCameraSnapshot = nextSnapshot
    companion object {
        var nextSnapshot = NativeCameraSnapshot(emptyList())
    }
}
