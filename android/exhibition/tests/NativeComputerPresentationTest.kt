package ai.openbuy.exhibition

fun main() {
    var cases = 0
    fun verify(value: Boolean, message: String) { check(value) { message }; cases++ }
    val page = NativeComputerPresentation.from("page", true, 90, active = true)
    verify(page.isPage && !page.isImage && !page.mirrored && page.rotation == 0,
        "Full webpage must not inherit camera mirroring or orientation")
    verify(page.showFullPage(true, true, true), "An active rendered page should replace native chrome")
    verify(!page.showFullPage(true, false, true), "First frame must render before hiding connection UI")
    verify(!page.showFullPage(true, true, false), "Lost backend must restore connection controls")
    verify(!page.showFullPage(false, true, true), "Closed session cannot retain a stale fullscreen page")
    val stopped = NativeComputerPresentation.from("page", active = false)
    verify(!stopped.showFullPage(true, true, true), "Stopping tab sharing must hide its final decoded frame")
    verify(!NativeComputerPresentation.from("page").showFullPage(true, true, true),
        "Missing page activity cannot revive a stale frame")
    for (source in listOf("camera", "output", "image")) {
        val media = NativeComputerPresentation.from(source, true, 270)
        verify(!media.isPage && media.mirrored && media.rotation == 270 && media.active,
            "Existing $source presentation changed")
        verify(!media.showFullPage(true, true, true), "Existing $source must keep native controls")
    }
    verify(NativeComputerPresentation.from("image").isImage, "Image mode no longer displays its poster")
    verify(!NativeComputerPresentation.from("unknown").isPage, "Unknown sources enabled fullscreen page mode")
    verify(NativeComputerPresentation.from("camera", rotation = 17).rotation == 0,
        "Malformed rotation should not crash the signal polling loop")
    verify(NativeComputerPresentation.from("page", active = true).presentationId == null,
        "Legacy page metadata must not invent a receipt batch")
    verify(NativeComputerPresentation.from("page", active = true, presentationId = 0).presentationId == 0L,
        "Presentation batch zero is valid")
    verify(NativeComputerPresentation.from("page", active = true, presentationId = 9_007_199_254_740_991L)
        .presentationId == 9_007_199_254_740_991L, "Safe integer presentation batch was rejected")
    verify(NativeComputerPresentation.from("page", presentationId = -1).presentationId == null &&
        NativeComputerPresentation.from("page", presentationId = Long.MAX_VALUE).presentationId == null,
        "Invalid presentation batches cannot be acknowledged")
    verify(NativeComputerPresentation.from("camera", presentationId = 9).presentationId == null,
        "A native video source must not carry page receipt state")
    println("NativeComputerPresentation passed ($cases assertions).")
}
