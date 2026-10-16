package ai.openbuy.exhibition

/** Pure JVM fixtures: no camera, USB permission, Android device, or provider session is opened. */
fun main() {
    var assertions = 0
    fun verify(condition: Boolean, message: String) { check(condition) { message }; assertions++ }
    fun device(id: String, facing: NativeCameraFacing) = NativeCameraDevice(id, facing,
        sizes = listOf(NativeCameraSize(1280, 720)), fpsRanges = listOf(NativeCameraFpsRange(15, 30)))
    val back = device("0", NativeCameraFacing.BACK)
    val front = device("1", NativeCameraFacing.FRONT)
    val external = device("100", NativeCameraFacing.EXTERNAL)
    val otherExternal = device("10", NativeCameraFacing.EXTERNAL)
    val unknown = device("vendor/device", NativeCameraFacing.UNKNOWN)
    val all = listOf(front, back, external, unknown)

    verify(NativeCameraSelection.Automatic.resolve(all) == external, "Automatic prefers external camera")
    verify(NativeCameraSelection.Automatic.resolve(listOf(front, unknown, back)) == back, "Automatic prefers back over front")
    verify(NativeCameraSelection.Automatic.resolve(listOf(unknown, front)) == front, "Automatic prefers front over unknown")
    verify(NativeCameraSelection.Automatic.resolve(listOf(unknown)) == unknown, "Unknown-facing system camera remains selectable")
    verify(NativeCameraSelection.Automatic.resolve(emptyList()) == null, "Empty system catalog has no camera")
    val externalPair = listOf(external, otherExternal)
    verify(NativeCameraSelection.Automatic.resolve(externalPair) == otherExternal, "Numeric IDs select deterministically within a facing")
    verify(NativeCameraSelection.Automatic.resolve(externalPair.reversed()) == otherExternal, "Enumeration order does not change the camera")
    verify(NativeCameraSelection.ordered(all + front).map { it.id } == listOf("100", "0", "1", "vendor/device"), "UI ordering follows preference and deduplicates IDs")

    val picked = NativeCameraSelection(front.id)
    verify(picked.resolve(all) == front, "Explicit front is not replaced by preferred external")
    verify(picked.resolve(listOf(back, external)) == null, "Missing explicit camera never falls back")
    verify(picked.cameraId == "1", "Unplug leaves the saved explicit identity intact")
    verify(picked.resolve(all.reversed()) == front, "Reconnected explicit camera is restored")
    verify(NativeCameraSelection("vendor/device").resolve(all) == unknown, "Opaque vendor camera IDs pass through exactly")
    verify(NativeCameraSelection("vendor/DEVICE").resolve(all) == null, "Explicit IDs are case-sensitive")
    try { NativeCameraSelection(""); error("Accepted empty explicit ID") } catch (_: IllegalArgumentException) { assertions++ }

    verify(NativeCameraSelection.migrate(null, "front", all).cameraId == "1", "Legacy front migrates to present front ID")
    verify(NativeCameraSelection.migrate(null, "back", all).cameraId == "0", "Legacy back migrates to present back ID")
    verify(NativeCameraSelection.migrate(null, "front", listOf(back, external)).isAutomatic, "Unavailable legacy direction becomes Automatic")
    verify(NativeCameraSelection.migrate(null, "back", emptyList()).isAutomatic, "No cameras during migration yields Automatic")
    verify(NativeCameraSelection.migrate(null, null, all).isAutomatic, "Fresh installation defaults to Automatic")
    verify(NativeCameraSelection.migrate(null, "unexpected", all).isAutomatic, "Unknown legacy preference defaults to Automatic")
    verify(NativeCameraSelection.migrate("", "back", all).isAutomatic, "Persisted Automatic is not overwritten by a stale legacy preference")
    verify(NativeCameraSelection.migrate("missing", "back", all).cameraId == "missing", "Persisted unavailable explicit ID is preserved")
    verify(NativeCameraSelection.migrate("100", "front", all).resolve(all) == external, "New identity takes priority over old direction")
    verify(NativeCameraSelection.migrate(picked.storedValue, null, all) == picked, "Explicit storage round trip")
    verify(NativeCameraSelection.migrate(NativeCameraSelection.Automatic.storedValue, "front", all).isAutomatic, "Automatic storage round trip")

    verify(external.label == "外接摄像头 · ID 100", "External label includes exact identity")
    verify(back.label == "后置摄像头 · ID 0", "Back label includes exact identity")
    verify(front.label == "前置摄像头 · ID 1", "Front label includes exact identity")
    verify(unknown.label == "摄像头 · ID vendor/device", "Unknown-facing label remains useful")
    verify(external.sizes.single() == NativeCameraSize(1280, 720), "Size capability remains intact")
    verify(external.fpsRanges.single() == NativeCameraFpsRange(15, 30), "FPS range remains intact")
    verify(external.copy(name = "USB Camera").label == "外接摄像头 · USB Camera · ID 100", "RTC name is shown with facing and exact ID")

    val rtcUnknown = NativeCameraDevice("100", NativeCameraFacing.UNKNOWN, name = "USB Camera")
    val rtcVendor = NativeCameraDevice("rtc-vendor-id", NativeCameraFacing.UNKNOWN, name = "Vendor Camera")
    val system = NativeCameraSnapshot(all, usbVideoDeviceCount = 1)
    verify(system.devices.isEmpty(), "System IDs alone can never become selectable capture devices")
    val merged = system.mergeRtcDevices(listOf(rtcVendor, rtcUnknown, front))
    verify(merged.devices.map { it.id } == listOf("100", "1", "rtc-vendor-id"), "Only actual RTC candidates are offered")
    verify(merged.systemDevices == all, "Original system detection remains available for diagnostics")
    verify(merged.devices.first().facing == NativeCameraFacing.EXTERNAL, "Exact-ID Camera2 match enriches unknown RTC facing")
    verify(merged.devices.first().name == "USB Camera", "RTC device name is preserved")
    verify(merged.devices.first().sizes == external.sizes && merged.devices.first().fpsRanges == external.fpsRanges, "Only exact matching metadata is added")
    verify(merged.devices.last().facing == NativeCameraFacing.UNKNOWN && merged.devices.last().sizes.isEmpty(), "Unmatched RTC camera is not guessed to be external")
    verify(system.mergeRtcDevices(listOf(NativeCameraDevice("100 ", NativeCameraFacing.UNKNOWN))).devices.single().sizes.isEmpty(), "Whitespace in opaque ID is never normalized for matching")
    verify(system.mergeRtcDevices(listOf(NativeCameraDevice("100", NativeCameraFacing.FRONT))).devices.single().facing == NativeCameraFacing.FRONT, "Known RTC facing is authoritative")
    verify(system.mergeRtcDevices(emptyList()).devices.isEmpty(), "Camera2 devices absent from RTC remain unavailable")
    verify(system.mergeRtcDevices(emptyList()).diagnostic == "系统检测到摄像头，但采集服务未提供可用设备", "System-only camera diagnosis")
    verify(NativeCameraSelection("0").resolve(merged.devices) == null, "Explicit system-only camera cannot silently substitute a RTC device")

    val empty = NativeCameraSnapshot(emptyList())
    val usbOnly = NativeCameraSnapshot(emptyList(), usbVideoDeviceCount = 1)
    val permission = NativeCameraSnapshot(emptyList(), 1, "请允许摄像头权限")
    verify(empty.diagnostic == "未检测到系统摄像头", "Empty catalog diagnosis")
    verify(usbOnly.diagnostic == "已连接 USB 视频设备，但系统未提供摄像头", "USB-only discovery never becomes a selectable camera")
    verify(NativeCameraSnapshot(listOf(back), 1).diagnostic == "已连接 USB 视频设备，系统未列出外接摄像头", "USB diagnostic distinguishes missing external Camera2 entry")
    verify(NativeCameraSnapshot(all, 1).diagnostic.isEmpty(), "Exposed external camera needs no diagnostic")
    verify(permission.diagnostic == "请允许摄像头权限", "Permission error takes precedence over USB diagnosis")
    verify(NativeCameraSelection.Automatic.unavailableMessage(usbOnly) == usbOnly.diagnostic, "Automatic failure uses discovery diagnosis")
    verify(picked.unavailableMessage(NativeCameraSnapshot(listOf(external)).mergeRtcDevices(listOf(external))) == "所选摄像头（ID 1）未连接", "Missing explicit ID is explained without fallback")
    verify(picked.unavailableMessage(permission) == permission.error, "Discovery permission failure is not mislabeled as unplugging")
    verify(picked.unavailableMessage(NativeCameraSnapshot(all).mergeRtcDevices(all)).isEmpty(), "Available explicit camera has no failure")

    for (installation in listOf(0, 90, 180, 270)) {
        verify(!NativeCameraCalibration.needsCalibration(installation, -1), "Follow-camera migration needs no calibration")
        for (legacyModel in listOf(0, 90, 180, 270))
            verify(NativeCameraCalibration.needsCalibration(installation, legacyModel) == (installation != legacyModel),
                "Conflicting old directions must never silently pick an angle")
    }
    println("Native camera selection passed: $assertions assertions; no camera or USB device opened.")
}
