package ai.openbuy.exhibition

/** Dialog-local, measured good modes. A stale or failed attempt never creates a verified mode. */
internal class NativeCameraPreviewRecovery {
    private var generation = 0L
    private var fallbackUsed = false
    private val verifiedSizes = mutableMapOf<String, NativeCameraSize>()

    fun beginOperation(): Long {
        fallbackUsed = false
        return ++generation
    }

    fun isCurrent(owner: Long): Boolean = owner == generation

    fun remember(owner: Long, device: NativeCameraDevice, actual: NativeCameraCaptureInfo?) {
        if (!isCurrent(owner) || actual == null) return
        val measured = NativeCameraSize(actual.width, actual.height)
        if (measured in NativeCameraCaptureSelection.options(device)) verifiedSizes[device.id] = measured
    }

    fun fallback(
        owner: Long,
        device: NativeCameraDevice,
        failed: NativeCameraCaptureSelection,
        releaseFailed: Boolean,
    ): NativeCameraCaptureSelection? {
        if (!isCurrent(owner) || fallbackUsed || releaseFailed) return null
        val measured = verifiedSizes[device.id] ?: return null
        if (measured !in NativeCameraCaptureSelection.options(device) ||
            runCatching { failed.resolve(device) }.getOrNull() == measured) return null
        fallbackUsed = true
        return NativeCameraCaptureSelection(measured)
    }
}
