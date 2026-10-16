package ai.xmax.sdk

/** 相机采集请求，独立于模型输入和上传编码尺寸；设备可能协商为其他分辨率。 */
public data class RealtimeCameraCaptureFormat(
    public val width: Int,
    public val height: Int,
    public val fps: Int,
) {
    /** 采集宽高须为不超过 8192 的正偶数，帧率为 1..120；不套用模型尺寸限制。 */
    public fun validate() {
        if (width !in 2..8192 || height !in 2..8192 || width % 2 != 0 || height % 2 != 0 || fps !in 1..120) {
            throw XmaxError(
                XmaxErrorCode.INVALID_CONFIGURATION,
                "Camera capture width and height must be positive even numbers up to 8192, and fps must be between 1 and 120",
            )
        }
    }
}
