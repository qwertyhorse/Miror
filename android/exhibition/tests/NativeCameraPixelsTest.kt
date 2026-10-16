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
    // Non-square marked input catches swapped geometry and accidental double rotation.
    val markedY = gray(16, 32, 48, 64, 80, 96, 112, 128)
    val markedChroma = gray(128, 128)
    fun marked(rotation: Int, mirrored: Boolean = false) = NativeCameraPixels.convert(4, 2, rotation,
        markedY, markedChroma, markedChroma, 4, 2, 2, 640, unmirror = mirrored)
    val marks = marked(0).argb
    val expected = mapOf(
        0 to listOf(0, 1, 2, 3, 4, 5, 6, 7),
        90 to listOf(4, 0, 5, 1, 6, 2, 7, 3),
        180 to listOf(7, 6, 5, 4, 3, 2, 1, 0),
        270 to listOf(3, 7, 2, 6, 1, 5, 0, 4),
    )
    for ((rotation, indices) in expected) {
        val output = marked(rotation)
        val swaps = rotation == 90 || rotation == 270
        verify(output.width == (if (swaps) 2 else 4) && output.height == (if (swaps) 4 else 2),
            "Non-square model sample geometry at $rotation")
        verify(output.argb.toList() == indices.map { marks[it] }, "All marked pixels rotate exactly once at $rotation")
        verify(marked(rotation, true).argb.toList() == indices.map { marks[it] }.chunked(output.width).flatMap { it.reversed() },
            "Mirror occurs horizontally after installation rotation at $rotation")
    }
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
    for (edge in listOf(480, 720, 960)) {
        val configured = NativeCameraPixels.convert(1280, 720, 90, ByteBuffer.wrap(ByteArray(1280 * 720) { 16 }),
            ByteBuffer.wrap(ByteArray(640 * 360) { 128.toByte() }), ByteBuffer.wrap(ByteArray(640 * 360) { 128.toByte() }),
            1280, 640, 640, edge)
        verify(configured.width == edge * 9 / 16 && configured.height == edge,
            "Linux $edge samples retain the configured resolution through YUV conversion")
    }
    val odd = NativeCameraPixels.convert(3, 1, 0, gray(16, 16, 235), gray(128, 128), gray(128, 128), 3, 2, 2, 640)
    verify(odd.argb.last() == 0xffffffff.toInt(), "Odd dimensions use rounded-up chroma planes")
    for (rotation in listOf(0, 90, 180, 270)) {
        val sourceY = ByteBuffer.wrap(ByteArray(132 * 66) { at -> (16 + (at * 7 % 220)).toByte() })
        val sourceU = ByteBuffer.wrap(ByteArray(66 * 33) { 128.toByte() })
        val sourceV = ByteBuffer.wrap(ByteArray(66 * 33) { 128.toByte() })
        for (longEdge in listOf(64, 640)) {
            val normal = NativeCameraPixels.convert(130, 65, rotation, sourceY, sourceU, sourceV, 132, 66, 66, longEdge)
            val unmirrored = NativeCameraPixels.convert(130, 65, rotation, sourceY, sourceU, sourceV, 132, 66, 66, longEdge, unmirror = true)
            verify(normal.width == unmirrored.width && normal.height == unmirrored.height,
                "Front-camera unmirror preserves upright dimensions at $rotation/$longEdge")
            val reflected = normal.argb.toList().chunked(normal.width).flatMap { it.reversed() }
            verify(unmirrored.argb.toList() == reflected,
                "Unmirror acts horizontally after $rotation degree rotation and bounded sampling")
        }
        verify(sourceY.position() == 0 && sourceU.position() == 0 && sourceV.position() == 0,
            "Rotated mirrored consumer retains source buffer ownership")
    }
    try {
        NativeCameraPixels.convert(2, 2, 0, gray(16, 16, 16), gray(128), gray(128), 2, 1, 1, 640)
        error("Accepted truncated source")
    } catch (_: IllegalArgumentException) { assertions++ }
    println("NativeCameraPixelsTest: $assertions assertions passed")
}
