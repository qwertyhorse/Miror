package android.os

class Looper {
    companion object {
        private val mainThread = Thread.currentThread()
        private val main = Looper()
        fun myLooper() = main.takeIf { Thread.currentThread() === mainThread }
        fun getMainLooper() = main
    }
}
object FixtureMain {
    private val tasks = ArrayDeque<() -> Unit>()
    val pendingCount get() = tasks.size
    fun post(task: () -> Unit) { tasks.addLast(task) }
    fun drain() { while (tasks.isNotEmpty()) tasks.removeFirst().invoke() }
}
class Handler(@Suppress("UNUSED_PARAMETER") looper: Looper) {
    fun post(task: Runnable): Boolean { FixtureMain.post { task.run() }; return true }
}
