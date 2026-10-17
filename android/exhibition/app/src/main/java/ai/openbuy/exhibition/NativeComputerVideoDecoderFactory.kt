package ai.openbuy.exhibition

import android.media.MediaCodecInfo
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.EglBase
import org.webrtc.HardwareVideoDecoderFactory
import org.webrtc.VideoCodecInfo
import org.webrtc.VideoDecoder
import org.webrtc.VideoDecoderFactory

/** Android WebRTC advertises constrained baseline only on some otherwise capable hardware.
 * Ordinary baseline allows Chromium on macOS to select its hardware H264 encoder. */
internal class NativeComputerVideoDecoderFactory internal constructor(
    private val fallback: VideoDecoderFactory,
    private val baselineHardware: VideoDecoderFactory,
) : VideoDecoderFactory {
    constructor(context: EglBase.Context) : this(
        DefaultVideoDecoderFactory(context),
        HardwareVideoDecoderFactory(context, ::supportsComputerBaselineDecoder),
    )

    // The hardware factory also checks hardware acceleration and usable output color formats.
    // If probing fails, preserve the original receiver capabilities rather than fabricate support.
    private val baselineAvailable = runCatching {
        baselineHardware.getSupportedCodecs().any { it.name.equals("H264", ignoreCase = true) }
    }.getOrDefault(false)

    override fun getSupportedCodecs(): Array<VideoCodecInfo> {
        val original = fallback.getSupportedCodecs()
        if (!baselineAvailable) return original
        return (listOf(VideoCodecInfo("H264", mapOf(
            "profile-level-id" to "42001f",
            "packetization-mode" to "1",
            "level-asymmetry-allowed" to "1",
        ), emptyList())) + original.filterNot {
            it.name.equals("H264", ignoreCase = true) &&
                it.params["profile-level-id"].equals("42001f", ignoreCase = true) &&
                it.params["packetization-mode"] == "1"
        }).toTypedArray()
    }

    override fun createDecoder(info: VideoCodecInfo): VideoDecoder? {
        if (baselineAvailable && info.name.equals("H264", ignoreCase = true) &&
            info.params["packetization-mode"] == "1" &&
            info.params["profile-level-id"]?.startsWith("4200", ignoreCase = true) == true) {
            // Never let the default factory select an earlier codec lacking ordinary baseline.
            return if (isComputerBaselineFormat(info.name, info.params)) baselineHardware.createDecoder(info) else null
        }
        return fallback.createDecoder(info)
    }
}

/** Only the additional ordinary-baseline packetization mode, including a negotiated lower level. */
internal fun isComputerBaselineFormat(name: String, parameters: Map<String, String>): Boolean {
    val profile = parameters["profile-level-id"] ?: return false
    return name.equals("H264", ignoreCase = true) && parameters["packetization-mode"] == "1" &&
        profile.length == 6 && profile.startsWith("4200", ignoreCase = true) &&
        profile.takeLast(2).lowercase() in setOf("0a", "0b", "0c", "0d", "14", "15", "16", "1e", "1f")
}

internal fun supportsComputerBaselineDecoder(info: MediaCodecInfo): Boolean = runCatching {
    if (info.isEncoder || info.name.endsWith(".secure", ignoreCase = true)) return@runCatching false
    val capabilities = info.getCapabilitiesForType("video/avc")
    if (capabilities.isFeatureRequired(MediaCodecInfo.CodecCapabilities.FEATURE_SecurePlayback) ||
        capabilities.isFeatureRequired(MediaCodecInfo.CodecCapabilities.FEATURE_TunneledPlayback)) return@runCatching false
    capabilities.profileLevels.any {
        it.profile == MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline && it.level in BASELINE_LEVELS
    }
}.getOrDefault(false)

// Advertise only level 3.1. A higher hardware ceiling proves this conservative capability;
// unknown levels and constrained-baseline-only capability do not authorize the added profile.
private val BASELINE_LEVELS = setOf(
    MediaCodecInfo.CodecProfileLevel.AVCLevel31, MediaCodecInfo.CodecProfileLevel.AVCLevel32,
    MediaCodecInfo.CodecProfileLevel.AVCLevel4, MediaCodecInfo.CodecProfileLevel.AVCLevel41,
    MediaCodecInfo.CodecProfileLevel.AVCLevel42, MediaCodecInfo.CodecProfileLevel.AVCLevel5,
    MediaCodecInfo.CodecProfileLevel.AVCLevel51, MediaCodecInfo.CodecProfileLevel.AVCLevel52,
    MediaCodecInfo.CodecProfileLevel.AVCLevel6, MediaCodecInfo.CodecProfileLevel.AVCLevel61,
    MediaCodecInfo.CodecProfileLevel.AVCLevel62,
)
