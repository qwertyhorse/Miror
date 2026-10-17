package android.os

class Looper {
    companion object { fun getMainLooper() = Looper() }
}

class Handler(@Suppress("UNUSED_PARAMETER") looper: Looper) {
    fun post(action: Runnable): Boolean { action.run(); return true }
}
