package ai.openbuy.exhibition

import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import com.google.mediapipe.tasks.vision.handlandmarker.InferenceFixture as Fixture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Real tracker scheduling and ownership; only Android pixels and MediaPipe inference are faked. */
fun main() {
    var assertions = 0
    fun verify(value: Boolean, message: String) { check(value) { message }; assertions++ }
    fun until(predicate: () -> Boolean) {
        val deadline = System.nanoTime() + 5_000_000_000
        while (!predicate()) { check(System.nanoTime() < deadline) { "Fixture timed out" }; Thread.sleep(2) }
    }
    fun pauseInference() { Fixture.entered = CountDownLatch(1); Fixture.resume = CountDownLatch(1) }
    fun awaitInference() { check(Fixture.entered!!.await(5, TimeUnit.SECONDS)) }
    fun resumeInference() { Fixture.resume!!.countDown() }
    var timestamp = 1000L
    val releases = AtomicInteger()
    val released = java.util.IdentityHashMap<NativeCameraFrame, AtomicInteger>()
    fun frame(generation: Long = 1, current: () -> Boolean = { true }): NativeCameraFrame {
        timestamp += 200
        val owned = AtomicInteger()
        return NativeCameraFrame(Bitmap(640, 360), timestamp, generation, current) { releases.incrementAndGet(); owned.incrementAndGet() }
            .also { released[it] = owned }
    }
    val received = mutableListOf<NativeHandResult>()
    var errors = 0
    val tracker = NativeHandTracker(Context(), received::add) { errors++ }
    val busyFlag = tracker.javaClass.getDeclaredField("busy").apply { isAccessible = true }.get(tracker) as java.util.concurrent.atomic.AtomicBoolean
    fun complete(frame: NativeCameraFrame) = released[frame]?.get() == 1 && !busyFlag.get()

    pauseInference()
    val first = frame()
    tracker.submit(first); awaitInference()
    val busy = frame(); tracker.submit(busy)
    verify(busy.bitmap.recycleCount.get() == 1 && Fixture.calls.get() == 1, "Busy inference drops and closes incoming sample")
    tracker.invalidate(); resumeInference()
    until { complete(first) }; Handler.drain()
    verify(received.isEmpty(), "Invalidated inference cannot emit its late result")
    first.close()
    verify(first.bitmap.recycleCount.get() == 1, "Sample close is idempotent")

    Fixture.entered = null; Fixture.resume = null
    val second = frame(); tracker.submit(second)
    until { complete(second) && Handler.pending() > 0 }; Handler.drain()
    verify(received.size == 1 && received.single().hands.size == 2 && received.single().hands[0].landmarks.size == 21,
        "Both hands and all landmarks are copied from the inference result")
    verify(received.single().width == 640 && received.single().height == 360 && received.single().timestampMs == second.timestampMs,
        "Output carries input aspect ratio and capture timestamp")

    var sourceCurrent = true
    val stale = frame { sourceCurrent }; tracker.submit(stale)
    until { complete(stale) && Handler.pending() > 0 }
    sourceCurrent = false; Handler.drain()
    verify(received.size == 1, "Controller invalidation is checked again on main-thread delivery")

    pauseInference()
    val configuring = frame(); tracker.submit(configuring); awaitInference()
    tracker.configure(.6f, .7f, .8f, 10, 320)
    resumeInference(); until { complete(configuring) }; Handler.drain()
    verify(received.size == 1, "Settings changes invalidate already-running inference")
    Fixture.entered = null; Fixture.resume = null
    val configured = frame(2); tracker.submit(configured)
    until { complete(configured) && Handler.pending() > 0 }; Handler.drain()
    verify(received.last().width == 320 && received.last().height == 180, "Configured analysis size is applied")
    verify(Fixture.lastOptions?.detection == .6f && Fixture.lastOptions?.presence == .7f && Fixture.lastOptions?.tracking == .8f,
        "All confidence settings configure the actual model")
    val oldGeneration = frame(1); tracker.submit(oldGeneration)
    verify(oldGeneration.bitmap.recycleCount.get() == 1, "Late frame from an old camera generation is discarded")

    Fixture.failLinkage = true
    val failed = frame(2); tracker.submit(failed)
    until { complete(failed) && Handler.pending() > 0 }; Handler.drain()
    verify(errors == 1, "Unavailable native inference library produces one concise error without stopping camera ownership")
    val callsBeforeRetry = Fixture.calls.get()
    val repeated = frame(2); tracker.submit(repeated); until { complete(repeated) }
    verify(Fixture.calls.get() == callsBeforeRetry, "Failed revision does not spin on model initialization")
    val createsBeforeRetry = Fixture.creates.get()
    Fixture.failLinkage = false; tracker.invalidate()
    val retry = frame(2); tracker.submit(retry)
    until { complete(retry) && Handler.pending() > 0 }; Handler.drain()
    verify(received.size == 3, "Explicit invalidation permits a clean retry")
    verify(Fixture.creates.get() == createsBeforeRetry + 1, "Inference failure is retried with a new model graph")

    pauseInference()
    val stopping = frame(2); tracker.submit(stopping); awaitInference()
    tracker.close(); resumeInference()
    until { complete(stopping) && Fixture.closes.get() == Fixture.creates.get() }; Handler.drain()
    verify(received.size == 3, "Closing while inference runs suppresses the result")
    val closed = frame(2); tracker.submit(closed); tracker.close()
    verify(closed.bitmap.recycleCount.get() == 1 && Fixture.threads.size == 1,
        "Closed tracker rejects samples; model construction, inference and teardown stay on one thread")
    verify(releases.get() == 12, "Every accepted or discarded sample releases ownership exactly once")
    println("NativeHandTrackerTest: $assertions assertions passed")
}
