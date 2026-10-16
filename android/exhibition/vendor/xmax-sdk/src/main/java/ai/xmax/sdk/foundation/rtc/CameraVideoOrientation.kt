package ai.xmax.sdk.foundation.rtc

/** Fixed orientation makes RTC apply frame rotation before encoding, with rotation metadata 0. */
internal enum class CameraVideoOrientation {
    ADAPTIVE,
    PORTRAIT,
    LANDSCAPE,
}
