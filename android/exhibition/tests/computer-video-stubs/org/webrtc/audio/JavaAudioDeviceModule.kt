package org.webrtc.audio
import android.content.Context

class JavaAudioDeviceModule {
    var microphoneMuted = false
    var speakerMuted = false
    var released = false
    fun setMicrophoneMute(value: Boolean) { microphoneMuted = value }
    fun setSpeakerMute(value: Boolean) { speakerMuted = value }
    fun release() { released = true }
    class Builder { fun createAudioDeviceModule() = JavaAudioDeviceModule().also { instances += it } }
    companion object {
        val instances = mutableListOf<JavaAudioDeviceModule>()
        fun builder(context: Context) = Builder()
    }
}
