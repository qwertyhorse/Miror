package ai.openbuy.exhibition

import android.media.MediaCodecInfo
import android.media.MediaCodecInfo.CodecCapabilities
import android.media.MediaCodecInfo.CodecProfileLevel
import org.webrtc.EglBase
import org.webrtc.HardwareVideoDecoderFactory
import org.webrtc.VideoCodecInfo
import org.webrtc.VideoDecoder
import org.webrtc.VideoDecoderFactory

/** Real compatibility factory; only Android capability queries and decoder creation are doubles. */
fun main() {
    var assertions = 0
    fun verify(condition: Boolean, message: String) { check(condition) { message }; assertions++ }
    fun codec(profile: String = "42001f", packet: String = "1") = VideoCodecInfo("H264", mapOf(
        "profile-level-id" to profile, "packetization-mode" to packet, "level-asymmetry-allowed" to "1"))
    fun capability(profile: Int = CodecProfileLevel.AVCProfileBaseline, level: Int = CodecProfileLevel.AVCLevel51,
        name: String = "OMX.amlogic.avc.decoder.awesome2", encoder: Boolean = false,
        required: Set<String> = emptySet(), hardware: Boolean = true) =
        MediaCodecInfo(name, encoder, hardware, CodecCapabilities(arrayOf(CodecProfileLevel(profile, level)), required))

    verify(supportsComputerBaselineDecoder(capability()), "Reported nonsecure Amlogic baseline level 5.1 was rejected")
    verify(supportsComputerBaselineDecoder(capability(level = CodecProfileLevel.AVCLevel31)), "Exact advertised level was rejected")
    for (profile in listOf(CodecProfileLevel.AVCProfileConstrainedBaseline, CodecProfileLevel.AVCProfileMain,
        CodecProfileLevel.AVCProfileHigh, 0)) {
        verify(!supportsComputerBaselineDecoder(capability(profile = profile)), "A different profile fabricated ordinary baseline: $profile")
    }
    for (level in listOf(CodecProfileLevel.AVCLevel3, 0, -1, Int.MAX_VALUE)) {
        verify(!supportsComputerBaselineDecoder(capability(level = level)), "Low or unknown level fabricated level 3.1: $level")
    }
    verify(!supportsComputerBaselineDecoder(capability(encoder = true)), "Encoder capability was treated as a decoder")
    verify(!supportsComputerBaselineDecoder(capability(name = "OMX.amlogic.avc.decoder.awesome2.secure")), "Secure decoder was accepted")
    for (feature in listOf(CodecCapabilities.FEATURE_SecurePlayback, CodecCapabilities.FEATURE_TunneledPlayback)) {
        verify(!supportsComputerBaselineDecoder(capability(required = setOf(feature))), "Required $feature was accepted")
    }
    verify(!supportsComputerBaselineDecoder(MediaCodecInfo(capabilities = null)), "Capability lookup failure did not fail closed")
    verify(!supportsComputerBaselineDecoder(MediaCodecInfo()), "Absent profileLevels fabricated baseline capability")

    val constrained = codec("42e01f")
    val vp8 = VideoCodecInfo("VP8")
    val fallback = DecoderFactoryFixture(arrayOf(vp8, constrained))
    val hardware = DecoderFactoryFixture(arrayOf(constrained))
    val factory = NativeComputerVideoDecoderFactory(fallback, hardware)
    val supported = factory.getSupportedCodecs()
    verify(supported.map { it.params["profile-level-id"] } == listOf("42001f", null, "42e01f"),
        "Compatibility format did not preserve original fallback order")
    verify(supported[1] === vp8 && supported[2] === constrained, "Original formats were replaced or mutated")
    verify(supported.first().params == codec().params, "Advertised profile, packetization or level was broadened")
    verify(factory.createDecoder(codec()) === hardware.decoder && fallback.requests.isEmpty(),
        "Ordinary baseline did not route exclusively to filtered hardware")
    verify(factory.createDecoder(codec("42001e")) === hardware.decoder, "A negotiated lower baseline level lost hardware routing")
    verify(factory.createDecoder(constrained) === fallback.decoder && factory.createDecoder(vp8) === fallback.decoder,
        "Existing constrained baseline or VP8 bypassed original fallback behavior")
    verify(factory.createDecoder(codec(packet = "0")) === fallback.decoder, "Packetization mode 0 was incorrectly added to hardware routing")
    val calls = fallback.requests.size to hardware.requests.size
    for (profile in listOf("42002a", "420033", "4200zz", "4200+a", "42001f00")) {
        verify(factory.createDecoder(codec(profile)) == null, "Unsupported baseline level bypassed filtering: $profile")
    }
    verify(calls == fallback.requests.size to hardware.requests.size, "Rejected profiles reached a decoder factory")
    hardware.decoder = null
    verify(factory.createDecoder(codec()) == null && fallback.requests.size == calls.first,
        "Unavailable filtered hardware silently selected a different default decoder")

    val absentHardware = DecoderFactoryFixture(emptyArray())
    val originalOnly = NativeComputerVideoDecoderFactory(fallback, absentHardware)
    verify(originalOnly.getSupportedCodecs().contentEquals(fallback.formats), "Absent compatible hardware advertised a new format")
    verify(originalOnly.createDecoder(constrained) === fallback.decoder, "No-hardware path lost original fallback")
    val failedProbe = NativeComputerVideoDecoderFactory(fallback, object : VideoDecoderFactory {
        override fun getSupportedCodecs(): Array<VideoCodecInfo> = throw IllegalStateException("fixture probe failed")
        override fun createDecoder(info: VideoCodecInfo): VideoDecoder? = error("Should not create decoder")
    })
    verify(failedProbe.getSupportedCodecs().contentEquals(fallback.formats), "Failed hardware probing broke existing capabilities")
    val duplicate = NativeComputerVideoDecoderFactory(DecoderFactoryFixture(arrayOf(codec(), constrained)), hardware)
    verify(duplicate.getSupportedCodecs().size == 2, "Existing ordinary baseline was advertised twice")

    // Exercise the production constructor and its MediaCodecInfo predicate, including the HW gate
    // provided by the library factory. No native decoder or EGL context is initialized by this fixture.
    HardwareVideoDecoderFactory.candidates = listOf(capability(hardware = false), capability(name = "decoder.secure"))
    verify(NativeComputerVideoDecoderFactory(EglBase.Context()).getSupportedCodecs().none { it.params["profile-level-id"] == "42001f" },
        "Software/secure-only codecs enabled the added hardware format")
    HardwareVideoDecoderFactory.candidates = listOf(capability(profile = CodecProfileLevel.AVCProfileConstrainedBaseline), capability())
    verify(NativeComputerVideoDecoderFactory(EglBase.Context()).getSupportedCodecs().first().params["profile-level-id"] == "42001f",
        "Production constructor did not use the capability-filtered hardware factory")
    HardwareVideoDecoderFactory.candidates = emptyList()
    println("NativeComputerVideoDecoderFactory passed ($assertions assertions); capability/routing boundaries, no hardware claims.")
}

private class DecoderFactoryFixture(val formats: Array<VideoCodecInfo>) : VideoDecoderFactory {
    val requests = mutableListOf<VideoCodecInfo>()
    var decoder: VideoDecoder? = object : VideoDecoder {}
    override fun getSupportedCodecs() = formats
    override fun createDecoder(info: VideoCodecInfo): VideoDecoder? { requests += info; return decoder }
}
