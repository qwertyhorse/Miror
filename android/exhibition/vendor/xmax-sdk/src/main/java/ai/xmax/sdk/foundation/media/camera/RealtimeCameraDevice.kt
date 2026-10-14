package ai.xmax.sdk

/** RTC 当前可用的摄像头；id 只能用于当前设备，外接或未知朝向的 position 为 null。 */
public data class RealtimeCameraDevice(
    public val id: String,
    public val name: String,
    public val position: CameraPosition?,
)
