package ai.openbuy.exhibition

fun main() {
    val gate = NativeGestureFrameGate()
    val first = checkNotNull(gate.begin(0))
    check(gate.begin(100) == null) // Drop, never queue an inference frame.
    gate.invalidate() // A busy transition makes the already evaluating event stale.
    check(!gate.complete(first))
    val busy = checkNotNull(gate.begin(310))
    gate.invalidate() // Completion also invalidates a frame sampled while busy.
    check(!gate.complete(busy))
    check(gate.begin(310) == null)
    check(gate.begin(200) == null)
    val current = checkNotNull(gate.begin(410))
    check(!gate.complete(first)) // An old callback cannot clear the current flight.
    check(gate.begin(510) == null)
    check(gate.complete(current))
    val stopping = checkNotNull(gate.begin(610))
    gate.invalidate(resetTimestamp = true)
    check(!gate.complete(stopping))
    val retry = checkNotNull(gate.begin(0))
    check(gate.complete(retry))
    val closing = checkNotNull(gate.begin(100))
    gate.close()
    check(!gate.complete(closing))
    check(gate.begin(200) == null)
    println("Native gesture callback and single-flight gate fixtures passed.")
}
