package ai.openbuy.exhibition

/** Preview rollback is bounded and uses only measured, still-available capture dimensions. */
fun main() {
    var assertions = 0
    fun verify(condition: Boolean, message: String) { check(condition) { message }; assertions++ }
    val hd = NativeCameraSize(1280, 720)
    val fullHd = NativeCameraSize(1920, 1080)
    val fourK = NativeCameraSize(3840, 2160)
    val firstCamera = NativeCameraDevice("usb-0", NativeCameraFacing.EXTERNAL,
        sizes = listOf(hd, fullHd, fourK))
    val secondCamera = firstCamera.copy(id = "usb-1")
    val fullHdSelection = NativeCameraCaptureSelection(fullHd)
    val fourKSelection = NativeCameraCaptureSelection(fourK)
    val fullHdActual = NativeCameraCaptureInfo(1920, 1080)

    run {
        val recovery = NativeCameraPreviewRecovery()
        val owner = recovery.beginOperation()
        verify(recovery.isCurrent(owner), "A new operation owns its recovery callbacks")
        verify(recovery.fallback(owner, firstCamera, fourKSelection, false) == null,
            "Without a verified preview, no fallback size is guessed")
        recovery.remember(owner, firstCamera, fullHdActual)
        verify(recovery.fallback(owner, firstCamera, fourKSelection, false) == fullHdSelection,
            "A failed UHD request restores the actual previously verified 1080p capture")
        verify(recovery.fallback(owner, firstCamera, fourKSelection, false) == null,
            "A single operation cannot start an endless fallback loop")
        val nextOwner = recovery.beginOperation()
        verify(!recovery.isCurrent(owner) && recovery.isCurrent(nextOwner),
            "Starting an operation invalidates the previous owner")
        verify(recovery.fallback(nextOwner, firstCamera, fourKSelection, false) == fullHdSelection,
            "Verified dimensions survive operation changes and permit a later independent recovery")
    }

    run {
        val recovery = NativeCameraPreviewRecovery()
        val staleOwner = recovery.beginOperation()
        val currentOwner = recovery.beginOperation()
        recovery.remember(staleOwner, firstCamera, fullHdActual)
        verify(recovery.fallback(currentOwner, firstCamera, fourKSelection, false) == null,
            "A delayed success callback from an old operation cannot create verified state")
        recovery.remember(currentOwner, firstCamera, fullHdActual)
        verify(recovery.fallback(staleOwner, firstCamera, fourKSelection, false) == null,
            "A delayed failure cannot initiate recovery after a new operation starts")
        verify(recovery.fallback(currentOwner, firstCamera, fourKSelection, false) == fullHdSelection,
            "A stale failure does not consume the current operation's recovery allowance")
        val closedOwner = recovery.beginOperation()
        verify(!recovery.isCurrent(currentOwner) && recovery.isCurrent(closedOwner),
            "Closing a preview can invalidate callbacks by advancing ownership")
        verify(recovery.fallback(currentOwner, firstCamera, fourKSelection, false) == null,
            "An invalidated operation cannot reopen the camera after close")
    }

    run {
        val recovery = NativeCameraPreviewRecovery()
        var owner = recovery.beginOperation()
        recovery.remember(owner, firstCamera, fullHdActual)
        verify(recovery.fallback(owner, secondCamera, fourKSelection, false) == null,
            "A different camera cannot borrow another camera's verified format")
        owner = recovery.beginOperation()
        recovery.remember(owner, secondCamera, NativeCameraCaptureInfo(1280, 720))
        verify(recovery.fallback(owner, secondCamera, fourKSelection, false) == NativeCameraCaptureSelection(hd),
            "The second camera recovers to its own measured capture dimensions")
        owner = recovery.beginOperation()
        verify(recovery.fallback(owner, firstCamera, fourKSelection, false) == fullHdSelection,
            "Switching back restores the first camera's independently verified size")
        owner = recovery.beginOperation()
        verify(recovery.fallback(owner, firstCamera.copy(id = "usb-0 "), fourKSelection, false) == null,
            "Camera identity matching does not normalize opaque IDs")
    }

    for ((label, actual) in listOf(
        "missing capture information" to null,
        "zero dimensions" to NativeCameraCaptureInfo(0, 1080),
        "negative dimensions" to NativeCameraCaptureInfo(-1920, 1080),
        "odd dimensions" to NativeCameraCaptureInfo(1919, 1080),
        "unadvertised dimensions" to NativeCameraCaptureInfo(1600, 900),
        "transposed driver mode" to NativeCameraCaptureInfo(1080, 1920),
        "oversized dimensions" to NativeCameraCaptureInfo(7680, 4320),
    )) {
        val recovery = NativeCameraPreviewRecovery()
        val owner = recovery.beginOperation()
        recovery.remember(owner, firstCamera, actual)
        verify(recovery.fallback(owner, firstCamera, fourKSelection, false) == null,
            "Do not record $label as a verified fallback")
    }

    run {
        val recovery = NativeCameraPreviewRecovery()
        var owner = recovery.beginOperation()
        recovery.remember(owner, firstCamera, fullHdActual)
        verify(recovery.fallback(owner, firstCamera, fourKSelection, true) == null,
            "A failed capture release must stop recovery rather than reopen a stuck HAL")
        owner = recovery.beginOperation()
        verify(recovery.fallback(owner, firstCamera, fullHdSelection, false) == null,
            "Do not retry the same explicit capture size that just failed")
        owner = recovery.beginOperation()
        verify(recovery.fallback(owner, firstCamera, NativeCameraCaptureSelection.Automatic, false) == null,
            "Do not retry when Automatic already requested the last verified dimensions")
        owner = recovery.beginOperation()
        verify(recovery.fallback(owner, firstCamera.copy(sizes = listOf(hd, fourK)), fourKSelection, false) == null,
            "A mode removed from current capabilities is not a valid recovery target")
        owner = recovery.beginOperation()
        verify(recovery.fallback(owner, firstCamera.copy(unavailableSizes = setOf(fullHd)), fourKSelection, false) == null,
            "A newly blocked mode is not a valid recovery target")
        owner = recovery.beginOperation()
        verify(recovery.fallback(owner, firstCamera.copy(sizes = emptyList()), fourKSelection, false) == null,
            "Unknown current capabilities do not justify replaying old measured dimensions")
    }

    run {
        val recovery = NativeCameraPreviewRecovery()
        val owner = recovery.beginOperation()
        val unavailableFullHd = firstCamera.copy(unavailableSizes = setOf(fullHd))
        recovery.remember(owner, unavailableFullHd, fullHdActual)
        verify(recovery.fallback(owner, firstCamera, fourKSelection, false) == null,
            "A mode known unavailable at measurement time must never be stored as verified")
    }

    run {
        val recovery = NativeCameraPreviewRecovery()
        var owner = recovery.beginOperation()
        recovery.remember(owner, firstCamera, fullHdActual)
        owner = recovery.beginOperation()
        recovery.remember(owner, firstCamera, NativeCameraCaptureInfo(1280, 720))
        verify(recovery.fallback(owner, firstCamera, fourKSelection, false) == NativeCameraCaptureSelection(hd),
            "A newer successful measured format replaces an older verified format")
    }

    println("Native camera preview recovery passed: $assertions assertions; no camera or Android runtime opened.")
}
