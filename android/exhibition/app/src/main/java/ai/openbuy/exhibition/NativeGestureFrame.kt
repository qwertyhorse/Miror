package ai.openbuy.exhibition

import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

/** Owned views of the SDK's copied tight I420 planes; no Android pixel processing or extra frame copy. */
internal class NativeGestureFrame(
    val width: Int,
    val height: Int,
    val rotationDegrees: Int,
    val mirrored: Boolean,
    y: ByteBuffer,
    u: ByteBuffer,
    v: ByteBuffer,
    yStride: Int,
    uStride: Int,
    vStride: Int,
    val timestampMs: Long,
    val generation: Long,
    private val current: () -> Boolean,
    private val release: () -> Unit,
) : AutoCloseable {
    private val closed = AtomicBoolean()
    val contentLength: Long
    private val pixels: List<ByteBuffer>

    init {
        require(width in 1..4096 && height in 1..4096 && width.toLong() * height <= 3840L * 2160) {
            "手势原始帧尺寸无效"
        }
        require(rotationDegrees in listOf(0, 90, 180, 270)) { "手势原始帧方向无效" }
        val chromaWidth = (width + 1) / 2
        val chromaHeight = (height + 1) / 2
        require(yStride == width && uStride == chromaWidth && vStride == chromaWidth) { "手势原始帧必须为紧密 I420" }
        val lengths = listOf(width * height, chromaWidth * chromaHeight, chromaWidth * chromaHeight)
        contentLength = lengths.sumOf { it.toLong() }
        require(contentLength <= 16L * 1024 * 1024) { "手势原始帧过大" }
        pixels = listOf(y, u, v).mapIndexed { index, plane ->
            require(plane.remaining() == lengths[index]) { "手势原始帧平面长度无效" }
            plane.slice().asReadOnlyBuffer()
        }
    }

    fun isCurrent(): Boolean = !closed.get() && current()
    fun planes(): List<ByteBuffer> = pixels.map { it.asReadOnlyBuffer() }
    override fun close() { if (closed.compareAndSet(false, true)) release() }
}
