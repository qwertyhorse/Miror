package ai.xmax.sdk

/** RTC 最近报告的采集帧尺寸与旋转信息；不是请求值，也不是模型编码尺寸。 */
public data class RealtimeCameraCaptureInfo(
    public val width: Int,
    public val height: Int,
    public val rotationDegrees: Int,
)
