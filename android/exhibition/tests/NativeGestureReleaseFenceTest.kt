package ai.openbuy.exhibition

fun main() {
    var assertions = 0
    fun verify(condition: Boolean) { check(condition); assertions++ }
    val fence = NativeGestureReleaseFence()
    verify(fence.required)
    verify(!fence.observe(0, false) && !fence.observe(600, false) && fence.required)
    verify(!fence.observe(700, true))
    verify(fence.observe(1_300, true) && !fence.required) // Slow but fresh inference clears startup release.
    fence.reset()
    verify(!fence.observe(1_400, true))
    verify(!fence.observe(1_700, false)) // A second hand or any held hand cancels release progress.
    verify(!fence.observe(1_800, true))
    verify(!fence.observe(2_100, true))
    verify(fence.observe(2_310, true))
    fence.reset()
    verify(!fence.observe(2_400, true))
    verify(!fence.observe(3_200, true) && fence.required) // Exactly 800 ms is stale, never counted.
    verify(!fence.observe(3_100, true) && fence.required) // Out-of-order samples restart observation.
    verify(!fence.observe(3_100, true))
    verify(fence.observe(3_700, true))
    println("NativeGestureReleaseFence: $assertions assertions passed")
}
