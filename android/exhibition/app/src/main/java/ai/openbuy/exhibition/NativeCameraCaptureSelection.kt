package ai.openbuy.exhibition

/** The camera's requested capture size is independent of the model's upload size. */
internal data class NativeCameraCaptureSelection(val size: NativeCameraSize? = null) {
    init { require(size == null || isSupportedSize(size)) { "采集分辨率无效" } }

    val storedValue: String get() = size?.let { "${it.width}x${it.height}" }.orEmpty()
    val label: String get() = size?.let(::label) ?: "自动"

    fun resolve(device: NativeCameraDevice): NativeCameraSize {
        val available = options(device)
        size?.let { requested ->
            require(requested in available) { "所选分辨率 ${requested.width}×${requested.height} 不可用，请重新选择" }
            return requested
        }
        if (available.isEmpty()) return NativeCameraSize(704, 1280)
        return available.firstOrNull { maxOf(it.width, it.height) <= 1920 && minOf(it.width, it.height) <= 1080 }
            ?: available.last()
    }

    companion object {
        val Automatic = NativeCameraCaptureSelection()

        fun fromStored(value: String?): NativeCameraCaptureSelection {
            if (value.isNullOrEmpty()) return Automatic
            val parts = Regex("([0-9]{1,4})x([0-9]{1,4})").matchEntire(value)?.destructured ?: return Automatic
            val (width, height) = parts
            val size = NativeCameraSize(width.toInt(), height.toInt())
            return if (isSupportedSize(size)) NativeCameraCaptureSelection(size) else Automatic
        }

        fun options(device: NativeCameraDevice): List<NativeCameraSize> = device.sizes
            .filter(::isSupportedSize).distinct()
            .sortedWith(compareByDescending<NativeCameraSize> { it.width.toLong() * it.height }.thenByDescending { it.width })

        fun label(size: NativeCameraSize): String = "${size.width}×${size.height}" +
            if (maxOf(size.width, size.height) >= 3840 && minOf(size.width, size.height) >= 2160) " · 4K" else ""

        private fun isSupportedSize(size: NativeCameraSize): Boolean =
            size.width > 0 && size.height > 0 && size.width % 2 == 0 && size.height % 2 == 0 &&
                maxOf(size.width, size.height) <= 4096 && minOf(size.width, size.height) <= 2160
    }
}

/** Measured RTC capture dimensions, not the requested or model-aligned size. */
internal data class NativeCameraCaptureInfo(val width: Int, val height: Int)
