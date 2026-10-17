package ai.openbuy.exhibition

/** Firmware exceptions are deliberately narrow; these fixtures never open a camera. */
fun main() {
    var assertions = 0
    fun verify(condition: Boolean, message: String) { check(condition) { message }; assertions++ }
    val hd = NativeCameraSize(1280, 720)
    val fullHd = NativeCameraSize(1920, 1080)
    val fourK = NativeCameraSize(3840, 2160)
    val portraitFourK = NativeCameraSize(2160, 3840)
    val cinemaFourK = NativeCameraSize(4096, 2160)
    val advertised = listOf(hd, fullHd, fourK, portraitFourK, cinemaFourK)
    val knownFirmware = NativeCameraFirmware(
        manufacturer = "Droidlogic",
        model = "ZC-H982",
        device = "t982_ar301",
        hardware = "amlogic",
        board = "t3",
        sdkInt = 30,
        release = "11",
        fingerprint = "Amlogic/p212/p212:9/PPR1.180610.011/20211221:userdebug/test-keys",
    )
    fun unavailable(
        firmware: NativeCameraFirmware = knownFirmware,
        cameraId: String = "0",
        pixelArraySize: NativeCameraSize? = fullHd,
        activeArraySize: NativeCameraSize? = fullHd,
        advertisedSizes: List<NativeCameraSize> = advertised,
    ) = NativeCameraCompatibility.unavailableSizes(
        firmware, cameraId, pixelArraySize, activeArraySize, advertisedSizes,
    )

    verify(unavailable() == setOf(fourK), "Only the proven UHD mode is unavailable on the exact affected firmware")
    verify(unavailable(advertisedSizes = advertised.reversed() + fourK) == setOf(fourK),
        "Capability order and duplicates do not change the firmware exception")
    for ((field, differentFirmware) in listOf(
        "manufacturer" to knownFirmware.copy(manufacturer = "Other vendor"),
        "model" to knownFirmware.copy(model = "t982_ar302"),
        "raw ro.product.model instead of the measured Build.MODEL" to knownFirmware.copy(model = "t982_ar301"),
        "device" to knownFirmware.copy(device = "t982_ar302"),
        "hardware" to knownFirmware.copy(hardware = "other-hardware"),
        "board" to knownFirmware.copy(board = "t4"),
        "SDK level" to knownFirmware.copy(sdkInt = 31),
        "Android release" to knownFirmware.copy(release = "12"),
        "firmware build" to knownFirmware.copy(
            fingerprint = "Amlogic/p212/p212:9/PPR1.180610.011/20221221:userdebug/test-keys",
        ),
        "missing fingerprint" to knownFirmware.copy(fingerprint = ""),
    )) {
        verify(unavailable(firmware = differentFirmware).isEmpty(),
            "A different $field must not inherit this camera restriction")
    }
    for (cameraId in listOf("1", "00", "0 ", "usb-0")) {
        verify(unavailable(cameraId = cameraId).isEmpty(), "An exact camera ID is required: $cameraId")
    }
    for (arraySize in listOf(null, NativeCameraSize(1080, 1920), fourK, NativeCameraSize(0, 0))) {
        verify(unavailable(pixelArraySize = arraySize).isEmpty(),
            "A different or unknown pixel array does not match: $arraySize")
        verify(unavailable(activeArraySize = arraySize).isEmpty(),
            "A different or unknown active array does not match: $arraySize")
    }
    verify(unavailable(advertisedSizes = advertised - fourK).isEmpty(),
        "Do not fabricate a blocked mode that this camera does not advertise")
    verify(unavailable(advertisedSizes = emptyList()).isEmpty(), "Unknown capabilities do not trigger a firmware exception")

    val affected = NativeCameraDevice("0", NativeCameraFacing.EXTERNAL, sizes = advertised,
        unavailableSizes = unavailable())
    val options = NativeCameraCaptureSelection.options(affected)
    verify(fourK !in options && fullHd in options && hd in options,
        "The known broken mode is hidden while working capture modes remain selectable")
    verify(portraitFourK in options && cinemaFourK in options,
        "Other 4K driver modes are not blocked by the UHD exception")
    val storedFourK = NativeCameraCaptureSelection.fromStored("3840x2160")
    val explicitFullHd = NativeCameraCaptureSelection(fullHd)
    verify(storedFourK.normalized(affected) == explicitFullHd,
        "A previously saved broken UHD selection migrates to advertised 1080p")
    verify(storedFourK.resolve(affected) == fullHd,
        "Startup resolves a saved broken mode safely without requiring the settings panel")
    verify(storedFourK.normalized(affected).normalized(affected) == explicitFullHd,
        "Compatibility migration is idempotent")
    val withoutFullHd = affected.copy(sizes = listOf(hd, fourK))
    verify(storedFourK.normalized(withoutFullHd) == NativeCameraCaptureSelection.Automatic,
        "When 1080p is absent, a known broken saved mode becomes Automatic")
    verify(storedFourK.resolve(withoutFullHd) == hd, "Automatic recovery uses an advertised safe mode")
    val fullHdAlsoUnavailable = affected.copy(unavailableSizes = setOf(fourK, fullHd))
    verify(storedFourK.normalized(fullHdAlsoUnavailable) == NativeCameraCaptureSelection.Automatic,
        "Migration cannot select an unavailable 1080p mode")
    verify(NativeCameraCaptureSelection.Automatic.normalized(affected) == NativeCameraCaptureSelection.Automatic,
        "Automatic remains Automatic")
    verify(explicitFullHd.normalized(affected) == explicitFullHd, "A valid saved selection remains unchanged")
    val unrelated = affected.copy(id = "other-camera", unavailableSizes = emptySet())
    verify(storedFourK.normalized(unrelated) == storedFourK && storedFourK.resolve(unrelated) == fourK,
        "An unaffected camera retains explicit UHD capture")
    val missingMode = unrelated.copy(sizes = listOf(hd, fullHd))
    verify(storedFourK.normalized(missingMode) == storedFourK,
        "Ordinary capability loss does not silently change a user's saved selection")
    verify(runCatching { storedFourK.resolve(missingMode) }.exceptionOrNull() is IllegalArgumentException,
        "An unsupported but unblocked explicit mode still fails rather than silently downgrading")

    val rtc = NativeCameraDevice("0", NativeCameraFacing.UNKNOWN,
        unavailableSizes = setOf(cinemaFourK))
    val merged = NativeCameraSnapshot(listOf(affected)).mergeRtcDevices(listOf(rtc)).devices.single()
    verify(merged.unavailableSizes == setOf(fourK, cinemaFourK),
        "Exact-ID Camera2 and RTC restrictions are both retained during device enrichment")
    verify(NativeCameraCaptureSelection.options(merged) == listOf(portraitFourK, fullHd, hd),
        "Merged restrictions reach the choices actually offered to the user")
    verify(NativeCameraSnapshot(listOf(affected)).mergeRtcDevices(listOf(rtc.copy(id = "1")))
        .devices.single().unavailableSizes == setOf(cinemaFourK),
        "A different RTC camera never inherits the system camera's restriction")
    verify(NativeCameraSnapshot(listOf(affected)).mergeRtcDevices(listOf(rtc.copy(sizes = listOf(fullHd, fourK))))
        .devices.single().unavailableSizes == setOf(fourK, cinemaFourK),
        "RTC-provided size metadata does not erase a matching firmware restriction")

    println("Native camera compatibility passed: $assertions assertions; no camera or Android runtime opened.")
}
