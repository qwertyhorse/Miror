package android.os
object Callbacks {
    private val pending = mutableListOf<Runnable>()
    fun add(callback: Runnable) { pending.add(callback) }
    fun remove(callback: Runnable) { pending.removeAll { it === callback } }
    fun flush() { while (pending.isNotEmpty()) pending.removeAt(0).run() }
}
class Looper {
    companion object {
        private val main = Looper()
        fun myLooper() = main
        fun getMainLooper() = main
    }
}
class Handler(looper: Looper) {
    fun post(callback: Runnable): Boolean { Callbacks.add(callback); return true }
    fun removeCallbacks(callback: Runnable) { Callbacks.remove(callback) }
}
