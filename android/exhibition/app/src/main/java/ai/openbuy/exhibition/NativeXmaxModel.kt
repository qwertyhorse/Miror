package ai.openbuy.exhibition

/** Only accept the backend's explicit model/region agreement; never silently upgrade a legacy session. */
internal object NativeXmaxModel {
    fun matches(model: String, region: String): Boolean = when (region) {
        "cn" -> model == "x2.1.1-preview-cn"
        "global" -> model == "x2.1.1-preview-us"
        else -> false
    }
}
