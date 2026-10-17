package ai.openbuy.exhibition

/** Camera identities and selection policy are independent of Android and the provider SDK. */
internal enum class NativeCameraFacing(val label: String, val priority: Int) {
    EXTERNAL("外接摄像头", 0),
    BACK("后置摄像头", 1),
    FRONT("前置摄像头", 2),
    UNKNOWN("摄像头", 3),
}

internal data class NativeCameraSize(val width: Int, val height: Int)
internal data class NativeCameraFpsRange(val min: Int, val max: Int)

internal data class NativeCameraDevice(
    val id: String,
    val facing: NativeCameraFacing,
    val name: String = "",
    val sizes: List<NativeCameraSize> = emptyList(),
    val fpsRanges: List<NativeCameraFpsRange> = emptyList(),
    val unavailableSizes: Set<NativeCameraSize> = emptySet(),
    val minimumFrameDurationsNs: Map<NativeCameraSize, Long> = emptyMap(),
) {
    val label: String get() {
        val shortName = name.takeUnless { it.startsWith("Camera ") && it.contains("Facing") }.orEmpty().trim().replace(Regex("\\s+"), " ").take(28).takeIf { it.isNotEmpty() && it != id }
        return "${facing.label}${shortName?.let { " · $it" }.orEmpty()} · ID $id"
    }
}

internal data class NativeCameraSnapshot(
    val systemDevices: List<NativeCameraDevice>,
    val usbVideoDeviceCount: Int = 0,
    val error: String? = null,
    val devices: List<NativeCameraDevice> = emptyList(),
    val rtcEnumerated: Boolean = false,
) {
    /** Only RTC can say which exact IDs its capture API accepts. Camera2 adds metadata, never candidates. */
    fun mergeRtcDevices(rtcDevices: List<NativeCameraDevice>): NativeCameraSnapshot {
        val systemById = systemDevices.associateBy { it.id }
        val merged = rtcDevices.map { rtc ->
            val system = systemById[rtc.id]
            if (system == null) rtc else rtc.copy(
                facing = if (rtc.facing == NativeCameraFacing.UNKNOWN) system.facing else rtc.facing,
                sizes = rtc.sizes.ifEmpty { system.sizes },
                fpsRanges = rtc.fpsRanges.ifEmpty { system.fpsRanges },
                unavailableSizes = rtc.unavailableSizes + system.unavailableSizes,
                minimumFrameDurationsNs = system.minimumFrameDurationsNs + rtc.minimumFrameDurationsNs,
            )
        }
        return copy(devices = NativeCameraSelection.ordered(merged), rtcEnumerated = true)
    }

    val diagnostic: String
        get() = when {
            devices.isEmpty() && !error.isNullOrBlank() -> error
            rtcEnumerated && devices.isEmpty() && systemDevices.isNotEmpty() -> "系统检测到摄像头，但采集服务未提供可用设备"
            devices.isEmpty() && systemDevices.isEmpty() && usbVideoDeviceCount > 0 -> "已连接 USB 视频设备，但系统未提供摄像头"
            devices.isEmpty() && systemDevices.isEmpty() -> "未检测到系统摄像头"
            usbVideoDeviceCount > 0 && systemDevices.none { it.facing == NativeCameraFacing.EXTERNAL } ->
                "已连接 USB 视频设备，系统未列出外接摄像头"
            else -> ""
        }
}

/** A missing explicit identity fails closed; only Automatic may select a different camera. */
internal data class NativeCameraSelection(val cameraId: String? = null) {
    init { require(cameraId == null || cameraId.isNotEmpty()) { "摄像头 ID 不能为空" } }

    val isAutomatic: Boolean get() = cameraId == null

    // Empty value means the user explicitly chose Automatic. Missing preference means not migrated yet.
    val storedValue: String get() = cameraId.orEmpty()

    fun resolve(devices: List<NativeCameraDevice>): NativeCameraDevice? =
        if (cameraId == null) ordered(devices).firstOrNull() else devices.firstOrNull { it.id == cameraId }

    fun unavailableMessage(snapshot: NativeCameraSnapshot): String = when {
        resolve(snapshot.devices) != null -> ""
        !snapshot.error.isNullOrBlank() -> snapshot.error
        cameraId != null -> "所选摄像头（ID $cameraId）未连接"
        else -> snapshot.diagnostic
    }

    companion object {
        val Automatic = NativeCameraSelection()

        fun ordered(devices: List<NativeCameraDevice>): List<NativeCameraDevice> = devices.distinctBy { it.id }
            .sortedWith(compareBy<NativeCameraDevice> { it.facing.priority }
                .thenBy { it.id.toLongOrNull() ?: Long.MAX_VALUE }.thenBy { it.id })

        /** Pass null for a missing new preference; pass "" for a persisted Automatic choice. */
        fun migrate(savedCameraId: String?, legacyPosition: String?, devices: List<NativeCameraDevice>): NativeCameraSelection {
            if (savedCameraId != null) return savedCameraId.takeIf { it.isNotEmpty() }?.let(::NativeCameraSelection) ?: Automatic
            val legacyFacing = when (legacyPosition) {
                "front" -> NativeCameraFacing.FRONT
                "back" -> NativeCameraFacing.BACK
                else -> return Automatic
            }
            return ordered(devices).firstOrNull { it.facing == legacyFacing }?.let { NativeCameraSelection(it.id) } ?: Automatic
        }
    }
}

/** Conflicting former preview/model settings require a human calibration before generation. */
internal object NativeCameraCalibration {
    fun needsCalibration(installation: Int, legacyModel: Int): Boolean =
        legacyModel in listOf(0, 90, 180, 270) && legacyModel != installation
}
