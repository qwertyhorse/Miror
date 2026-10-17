package ai.openbuy.exhibition

internal data class NativeCameraFirmware(
    val manufacturer: String,
    val model: String,
    val device: String,
    val hardware: String,
    val board: String,
    val sdkInt: Int,
    val release: String,
    val fingerprint: String,
)

/** Explicit driver exceptions, not a general inference from sensor size or an unverified timeout. */
internal object NativeCameraCompatibility {
    private val affectedFirmware = NativeCameraFirmware(
        manufacturer = "Droidlogic",
        // Measured from android.os.Build in the Java runtime. On this firmware,
        // `getprop ro.product.model` says t982_ar301 but Build.MODEL is ZC-H982.
        model = "ZC-H982",
        device = "t982_ar301",
        hardware = "amlogic",
        board = "t3",
        sdkInt = 30,
        release = "11",
        fingerprint = "Amlogic/p212/p212:9/PPR1.180610.011/20211221:userdebug/test-keys",
    )
    private val sensorSize = NativeCameraSize(1920, 1080)
    private val brokenSize = NativeCameraSize(3840, 2160)

    fun unavailableSizes(
        firmware: NativeCameraFirmware,
        cameraId: String,
        pixelArraySize: NativeCameraSize?,
        activeArraySize: NativeCameraSize?,
        advertisedSizes: List<NativeCameraSize>,
    ): Set<NativeCameraSize> {
        // This firmware advertises 4K/30 but submits NV21 to a HAL that returns -38 and can
        // deadlock during close. Confirmed on both RTC providers; do not probe it again.
        return if (firmware == affectedFirmware && cameraId == "0" &&
            pixelArraySize == sensorSize && activeArraySize == sensorSize && brokenSize in advertisedSizes)
            setOf(brokenSize) else emptySet()
    }
}
