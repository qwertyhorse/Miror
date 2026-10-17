package android.media

class MediaCodecInfo(
    val name: String = "OMX.fixture.avc.decoder",
    val isEncoder: Boolean = false,
    val hardware: Boolean = true,
    private val capabilities: CodecCapabilities? = CodecCapabilities(),
) {
    fun getCapabilitiesForType(mime: String): CodecCapabilities {
        require(mime == "video/avc")
        return capabilities ?: throw IllegalArgumentException("Unknown codec capabilities")
    }
    class CodecCapabilities(
        val profileLevels: Array<CodecProfileLevel> = emptyArray(),
        private val requiredFeatures: Set<String> = emptySet(),
    ) {
        fun isFeatureRequired(feature: String) = feature in requiredFeatures
        companion object {
            const val FEATURE_SecurePlayback = "secure-playback"
            const val FEATURE_TunneledPlayback = "tunneled-playback"
        }
    }
    class CodecProfileLevel(val profile: Int, val level: Int) {
        companion object {
            const val AVCProfileBaseline = 1
            const val AVCProfileMain = 2
            const val AVCProfileHigh = 8
            const val AVCProfileConstrainedBaseline = 65536
            const val AVCLevel3 = 256
            const val AVCLevel31 = 512
            const val AVCLevel32 = 1024
            const val AVCLevel4 = 2048
            const val AVCLevel41 = 4096
            const val AVCLevel42 = 8192
            const val AVCLevel5 = 16384
            const val AVCLevel51 = 32768
            const val AVCLevel52 = 65536
            const val AVCLevel6 = 131072
            const val AVCLevel61 = 262144
            const val AVCLevel62 = 524288
        }
    }
}
