package ai.openbuy.exhibition

import java.nio.ByteBuffer

/** Exercises actual I420 conversion without Android bitmap stubs or camera hardware. */
fun main() {
    var assertions = 0
    fun verify(value: Boolean, message: String) { check(value) { message }; assertions++ }
    fun gray(vararg values: Int) = ByteBuffer.wrap(values.map(Int::toByte).toByteArray())
    fun convert(rotation: Int = 0) = NativeCameraPixels.convert(2, 2, rotation,
        gray(16, 64, 128, 235), gray(128), gray(128), 2, 1, 1, 640)
    val base = convert()
    verify(base.argb[0] == 0xff000000.toInt(), "Video-range black is opaque black")
    verify(base.argb[3] == 0xffffffff.toInt(), "Video-range white is opaque white")
    verify((base.argb[1] and 255) in 55..56, "YUV limited-range luminance is expanded")
    verify(convert(90).argb.toList() == listOf(base.argb[2], base.argb[0], base.argb[3], base.argb[1]), "90 degree input rotation")
    verify(convert(180).argb.toList() == base.argb.reversed(), "180 degree input rotation")
    verify(convert(270).argb.toList() == listOf(base.argb[1], base.argb[3], base.argb[0], base.argb[2]), "270 degree input rotation")
    val padded = gray(99, 16, 64, 99, 128, 235, 99).apply { position(1) }
    val chroma = gray(99, 128).apply { position(1) }
    val paddedResult = NativeCameraPixels.convert(2, 2, 0, padded, chroma, chroma, 3, 1, 1, 640)
    verify(paddedResult.argb.contentEquals(base.argb), "Stride and initial buffer positions are respected")
    verify(padded.position() == 1 && chroma.position() == 1, "Consumer buffer positions are unchanged")
    val red = NativeCameraPixels.convert(1, 1, 0, gray(82), gray(90), gray(240), 1, 1, 1, 640).argb.single()
    verify((red shr 16 and 255) >= 253 && (red shr 8 and 255) <= 1 && (red and 255) <= 1, "U and V are not swapped")
    val reduced = NativeCameraPixels.convert(1280, 720, 90, ByteBuffer.wrap(ByteArray(1280 * 720) { 16 }),
        ByteBuffer.wrap(ByteArray(640 * 360) { 128.toByte() }), ByteBuffer.wrap(ByteArray(640 * 360) { 128.toByte() }),
        1280, 640, 640, 640)
    verify(reduced.width == 360 && reduced.height == 640 && reduced.argb.size == 360 * 640, "Rotation and reduction bound allocation before conversion")
    val odd = NativeCameraPixels.convert(3, 1, 0, gray(16, 16, 235), gray(128, 128), gray(128, 128), 3, 2, 2, 640)
    verify(odd.argb.last() == 0xffffffff.toInt(), "Odd dimensions use rounded-up chroma planes")
    try {
        NativeCameraPixels.convert(2, 2, 0, gray(16, 16, 16), gray(128), gray(128), 2, 1, 1, 640)
        error("Accepted truncated source")
    } catch (_: IllegalArgumentException) { assertions++ }
    println("NativeCameraPixelsTest: $assertions assertions passed")
}
