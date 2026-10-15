package ai.xmax.sdk.foundation.rtc

/** Raw RTC pixels plus their orientation; never add the installation correction again. */
internal data class CameraFrameGeometry(val width: Int, val height: Int, val rotationDegrees: Int) {
    val isValid: Boolean get() = width in 1..8192 && height in 1..8192 && rotationDegrees in listOf(0, 90, 180, 270)
    private val swapsDimensions get() = rotationDegrees == 90 || rotationDegrees == 270
    val displayWidth: Int get() = if (swapsDimensions) height else width
    val displayHeight: Int get() = if (swapsDimensions) width else height
}
