package android.os
import java.util.concurrent.ConcurrentLinkedQueue
object SystemClock { fun elapsedRealtime(): Long = java.lang.System.nanoTime() / 1_000_000 }
class Looper { companion object { fun getMainLooper() = Looper() } }
class Handler(looper: Looper) {
 fun post(callback: () -> Unit): Boolean { callbacks.add(callback); return true }
 companion object {
  private val callbacks = ConcurrentLinkedQueue<() -> Unit>()
  fun drain() { while (true) (callbacks.poll() ?: return).invoke() }
  fun pending() = callbacks.size
 }
}
