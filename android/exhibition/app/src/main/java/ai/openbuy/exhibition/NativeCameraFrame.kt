package ai.openbuy.exhibition

import android.graphics.Bitmap
import java.util.concurrent.atomic.AtomicBoolean

/** One owned camera sample. close() recycles its pixels and releases capture backpressure. */
class NativeCameraFrame internal constructor(
    val bitmap: Bitmap,
    val timestampMs: Long,
    val generation: Long,
    val isCurrent: () -> Boolean,
    private val release: () -> Unit,
) : AutoCloseable {
    private val closed = AtomicBoolean()
    override fun close() {
        if (closed.compareAndSet(false, true)) {
            try { if (!bitmap.isRecycled) bitmap.recycle() } finally { release() }
        }
    }
}
