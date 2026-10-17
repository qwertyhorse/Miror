package ai.openbuy.exhibition

/** The camera's requested capture size is independent of the model's upload size. */
internal data class NativeCameraCaptureSelection(val size: NativeCameraSize? = null) {
    init { require(size == null || isSupportedSize(size)) { "采集分辨率无效" } }

    val storedValue: String get() = size?.let { "${it.width}x${it.height}" }.orEmpty()
    val label: String get() = size?.let(::label) ?: "自动"

    /** Migrate only a proven driver-incompatible choice, including preferences saved by older builds. */
    fun normalized(device: NativeCameraDevice): NativeCameraCaptureSelection {
        if (size !in device.unavailableSizes) return this
        val stable = NativeCameraSize(1920, 1080)
        return if (stable in options(device)) NativeCameraCaptureSelection(stable) else Automatic
    }

    fun resolve(device: NativeCameraDevice): NativeCameraSize {
        val available = options(device)
        normalized(device).size?.let { requested ->
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
            .filter { isSupportedSize(it) && it !in device.unavailableSizes }.distinct()
            .sortedWith(compareByDescending<NativeCameraSize> { it.width.toLong() * it.height }.thenByDescending { it.width })

        /** Capture only: model/encoding fps remain independent. Raise the compatible 24 fps
         * request only when both AE and this exact output size report sufficient capacity. */
        fun framesPerSecond(device: NativeCameraDevice, size: NativeCameraSize): Int {
            val aeCeiling = device.fpsRanges.asSequence()
                .filter { it.min in 1..30 && it.max >= it.min }
                .maxOfOrNull { it.max }
            val duration = device.minimumFrameDurationsNs[size]?.takeIf { it > 0 && size in options(device) }
            val sizeCeiling = duration?.let { minimumNs ->
                // Integer nanosecond rounding must not turn a nominal 30 fps period into 29.
                (30 downTo 1).firstOrNull { fps -> minimumNs <= (1_000_000_000L + fps - 1) / fps } ?: 1
            }
            val preferred = if (aeCeiling != null && sizeCeiling != null) 30 else 24
            return minOf(preferred, aeCeiling ?: preferred, sizeCeiling ?: preferred).coerceIn(1, 30)
        }

        fun label(size: NativeCameraSize): String = "${size.width}×${size.height}" +
            if (maxOf(size.width, size.height) >= 3840 && minOf(size.width, size.height) >= 2160) " · 4K" else ""

        private fun isSupportedSize(size: NativeCameraSize): Boolean =
            size.width > 0 && size.height > 0 && size.width % 2 == 0 && size.height % 2 == 0 &&
                maxOf(size.width, size.height) <= 4096 && minOf(size.width, size.height) <= 2160
    }
}

/** Measured RTC capture dimensions, not the requested or model-aligned size. */
internal data class NativeCameraCaptureInfo(val width: Int, val height: Int)
