package android.os

/** JVM fixture clock; never packaged in the Android application. */
object SystemClock {
    @JvmStatic fun elapsedRealtime(): Long = System.nanoTime() / 1_000_000
}
