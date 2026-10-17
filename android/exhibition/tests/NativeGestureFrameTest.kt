package ai.openbuy.exhibition

import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.*
import org.json.JSONObject

fun main() = runBlocking {
    var assertions = 0
    fun verify(value: Boolean, message: String) { check(value) { message }; assertions++ }
    fun raw(width: Int = 5, height: Int = 3, rotation: Int = 90, yStride: Int = width,
        uStride: Int = (width + 1) / 2, vStride: Int = uStride, ySize: Int = width * height,
        current: () -> Boolean = { true }, release: () -> Unit = {}): NativeGestureFrame {
        val chroma = ((width + 1) / 2) * ((height + 1) / 2)
        return NativeGestureFrame(width, height, rotation, true, ByteBuffer.allocate(ySize),
            ByteBuffer.allocate(chroma), ByteBuffer.allocate(chroma), yStride, uStride, vStride, 1, 1, current, release)
    }
    val count = AtomicInteger()
    var valid = true
    val odd = raw(current = { valid }, release = { count.incrementAndGet() })
    verify(odd.contentLength == 27L && odd.planes().map { it.remaining() } == listOf(15, 6, 6),
        "Odd dimensions preserve ceil chroma dimensions in Y/U/V order")
    odd.planes().first().position(3)
    verify(odd.planes().first().position() == 0 && odd.planes().all { it.isReadOnly },
        "Upload readers have independent read-only plane positions")
    valid = false
    verify(!odd.isCurrent(), "Switching camera/settings invalidates a retained frame")
    odd.close(); odd.close()
    verify(count.get() == 1 && !odd.isCurrent(), "Double close releases capture reservation exactly once")
    for (rotation in listOf(0, 90, 180, 270)) raw(rotation = rotation).close()
    verify(runCatching { raw(rotation = 45) }.isFailure, "Unknown rotation is rejected")
    verify(runCatching { raw(yStride = 6) }.isFailure && runCatching { raw(uStride = 4) }.isFailure &&
        runCatching { raw(vStride = 4) }.isFailure, "Padded strides cannot be falsely advertised as tight I420")
    verify(runCatching { raw(ySize = 14) }.isFailure && runCatching { raw(ySize = 16) }.isFailure,
        "Truncated and oversized planes are rejected before upload")
    verify(runCatching { raw(width = 0) }.isFailure && runCatching { raw(width = 4097, height = 1) }.isFailure,
        "Dimensions are independently bounded")
    verify(runCatching { raw(width = 4096, height = 2160) }.isFailure, "Pixel count is bounded independently of dimensions")
    val largest = raw(width = 3840, height = 2160)
    verify(largest.contentLength == 12_441_600L, "Full 4K I420 fits the 16 MiB transport limit unchanged")
    largest.close()
    val bytes = ByteArray(15)
    val shared = NativeGestureFrame(5, 3, 0, false, ByteBuffer.wrap(bytes), ByteBuffer.allocate(6),
        ByteBuffer.allocate(6), 5, 3, 3, 1, 1, { true }) {}
    bytes[0] = 42
    verify(shared.planes()[0].get(0) == 42.toByte(), "Frame wrapper holds SDK planes without another allocation/copy")
    shared.close()

    val opened = AtomicInteger()
    val closed = AtomicInteger()
    val uploaded = AtomicInteger()
    val errors = mutableListOf<String>()
    val legacy = object : NativeGestureTransport {
        override suspend fun open() = JSONObject().put("sessionId", "old-peer").put("epoch", 0).also { opened.incrementAndGet() }
        override suspend fun control(sessionId: String, epoch: Long, blocked: Boolean, reset: Boolean): JSONObject = error("Legacy peer must not control")
        override suspend fun frame(metadata: NativeGestureUpload, frame: NativeGestureFrame): JSONObject {
            uploaded.incrementAndGet(); return JSONObject()
        }
        override suspend fun close(sessionId: String) { closed.incrementAndGet() }
    }
    val remote = NativeRemoteGestures(legacy, {}, { errors.add(it) }, callbackDispatcher = Dispatchers.Unconfined)
    remote.configure(true, false, "one")
    verify(errors.single().contains("更新电脑后台") && !remote.canAcceptFrame(), "Old backend gives an explicit update requirement before sampling")
    val refused = raw(release = { count.incrementAndGet() })
    remote.submit(refused)
    remote.configure(true, false, "two", 30, 960)
    verify(opened.get() == 1 && uploaded.get() == 0 && closed.get() == 1 && !refused.isCurrent(),
        "No JPEG fallback or repeated reopen is attempted against an incompatible backend")
    remote.close()
    println("NativeGestureFrame: $assertions assertions passed; raw planes and legacy protocol only")
}
