package ai.openbuy.exhibition

/** Size policy tests require no camera, Android runtime, or cloud session. */
fun main() {
    var assertions = 0
    fun verify(condition: Boolean, message: String) { check(condition) { message }; assertions++ }
    fun rejects(message: String, action: () -> Unit) {
        val failure = runCatching(action).exceptionOrNull()
        verify(failure is IllegalArgumentException, message)
    }
    fun device(vararg sizes: NativeCameraSize) = NativeCameraDevice("usb-1", NativeCameraFacing.EXTERNAL, sizes = sizes.toList())
    val hd = NativeCameraSize(1280, 720)
    val fullHd = NativeCameraSize(1920, 1080)
    val portraitFullHd = NativeCameraSize(1080, 1920)
    val fourK = NativeCameraSize(3840, 2160)
    val cinemaFourK = NativeCameraSize(4096, 2160)
    val portraitFourK = NativeCameraSize(2160, 3840)
    val automatic = NativeCameraCaptureSelection.Automatic

    verify(automatic.size == null && automatic.storedValue.isEmpty(), "Automatic has no fixed capture dimensions")
    for (stored in listOf(null, "", "auto", "3840X2160", "3840×2160", " 3840x2160", "3840x2160 ",
        "3840x2160x24", "0x1080", "1921x1080", "-1920x1080", "8192x4320", "5000x1080", "2162x4096", "999999999x2160")) {
        verify(NativeCameraCaptureSelection.fromStored(stored) == automatic, "Invalid or absent stored choice uses Automatic: $stored")
    }
    for (size in listOf(hd, fullHd, portraitFullHd, fourK, cinemaFourK, portraitFourK, NativeCameraSize(2160, 4096))) {
        val selection = NativeCameraCaptureSelection(size)
        verify(NativeCameraCaptureSelection.fromStored(selection.storedValue) == selection, "Explicit dimensions round trip: $size")
    }
    rejects("Odd dimensions are not a valid explicit capture choice") { NativeCameraCaptureSelection(NativeCameraSize(1279, 720)) }
    rejects("A negative capture size is invalid") { NativeCameraCaptureSelection(NativeCameraSize(-1280, 720)) }
    rejects("A size beyond the capture bounds is invalid") { NativeCameraCaptureSelection(NativeCameraSize(4096, 2162)) }

    val mixed = device(hd, fourK, fullHd, hd, portraitFourK, cinemaFourK, portraitFullHd,
        NativeCameraSize(0, 1080), NativeCameraSize(1921, 1080), NativeCameraSize(4098, 2160), NativeCameraSize(2162, 4096))
    val options = NativeCameraCaptureSelection.options(mixed)
    verify(options == listOf(cinemaFourK, fourK, portraitFourK, fullHd, portraitFullHd, hd),
        "Only valid advertised sizes are offered, deduplicated and ordered by area")
    verify(NativeCameraCaptureSelection.options(mixed.copy(sizes = mixed.sizes.reversed())) == options,
        "Capability order does not change choices")
    verify(automatic.resolve(mixed) == fullHd, "Automatic selects the largest advertised size within 1080p")
    verify(automatic.resolve(device(hd, portraitFullHd, fourK)) == portraitFullHd, "Automatic supports portrait 1080p capture")
    verify(automatic.resolve(device(hd, NativeCameraSize(1600, 1200), fourK)) == hd,
        "Automatic keeps both dimensions within the 1080p envelope")
    verify(automatic.resolve(device(cinemaFourK, fourK)) == fourK,
        "When only larger captures exist, Automatic uses the smallest advertised size")
    verify(automatic.resolve(device()) == NativeCameraSize(704, 1280), "Unknown capabilities retain the compatible capture request")
    verify(automatic.resolve(device(NativeCameraSize(9999, 9999))) == NativeCameraSize(704, 1280),
        "An unusable capability list is treated as unknown")
    verify(NativeCameraCaptureSelection.options(device()).isEmpty(), "Unknown capabilities never fabricate 4K choices")
    val explicit = NativeCameraCaptureSelection(fourK)
    verify(explicit.resolve(mixed) == fourK, "An explicit supported 4K choice is passed through")
    rejects("An explicit unavailable size must not silently downgrade") { explicit.resolve(device(fullHd, hd)) }
    rejects("An explicit request cannot be confirmed from unknown capabilities") { explicit.resolve(device()) }
    rejects("Transposed dimensions are separate driver modes, not interchangeable") { explicit.resolve(device(portraitFourK)) }
    verify(explicit.size == fourK && explicit.resolve(mixed) == fourK,
        "Changing to an incompatible camera preserves the choice for switching back")
    verify(automatic.resolve(device(hd)) == hd && automatic.resolve(mixed) == fullHd,
        "Automatic adapts to the selected camera instead of carrying a prior camera's dimensions")
    verify(mixed.id == "usb-1", "Resolving capture size never changes the selected device")

    verify(automatic.label == "自动", "Automatic label is concise")
    verify(explicit.label == "3840×2160 · 4K", "Advertised UHD mode is visibly labeled 4K")
    verify(NativeCameraCaptureSelection(portraitFourK).label == "2160×3840 · 4K", "Portrait UHD mode is visibly labeled 4K")
    verify(NativeCameraCaptureSelection(cinemaFourK).label == "4096×2160 · 4K", "DCI mode is visibly labeled 4K")
    verify(NativeCameraCaptureSelection(fullHd).label == "1920×1080", "1080p is never labeled 4K")
    val measured = NativeCameraCaptureInfo(1920, 1080)
    verify(measured.width == 1920 && measured.height == 1080 && explicit.size == fourK,
        "Measured dimensions remain distinct from the user's requested resolution")
    println("Native capture selection passed: $assertions assertions; no camera or cloud session opened.")
}
