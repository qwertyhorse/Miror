package ai.openbuy.exhibition

import android.content.Context
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Size

/** Read-only enumeration. This never opens a camera or requests access to a USB device. */
internal class NativeCameraCatalog(context: Context) {
    private val context = context.applicationContext

    fun snapshot(): NativeCameraSnapshot {
        val usbCount = usbVideoDeviceCount()
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
            ?: return NativeCameraSnapshot(emptyList(), usbCount, "系统相机服务不可用")
        val ids = try {
            manager.cameraIdList
        } catch (_: SecurityException) {
            return NativeCameraSnapshot(emptyList(), usbCount, "请允许摄像头权限")
        } catch (_: CameraAccessException) {
            return NativeCameraSnapshot(emptyList(), usbCount, "无法读取摄像头列表，请重试")
        }
        var denied = false
        val devices = ids.distinct().mapNotNull { id ->
            try {
                val characteristics = manager.getCameraCharacteristics(id)
                val facing = when (characteristics.get(CameraCharacteristics.LENS_FACING)) {
                    CameraCharacteristics.LENS_FACING_EXTERNAL -> NativeCameraFacing.EXTERNAL
                    CameraCharacteristics.LENS_FACING_BACK -> NativeCameraFacing.BACK
                    CameraCharacteristics.LENS_FACING_FRONT -> NativeCameraFacing.FRONT
                    else -> NativeCameraFacing.UNKNOWN
                }
                // SurfaceTexture sizes describe the normal preview/video output used by the RTC SDK.
                val streamMap = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                val sizes = streamMap?.getOutputSizes(SurfaceTexture::class.java)?.map { NativeCameraSize(it.width, it.height) }
                    .orEmpty().filter { it.width > 0 && it.height > 0 }.distinct()
                    .sortedWith(compareByDescending<NativeCameraSize> { it.width.toLong() * it.height }.thenByDescending { it.width })
                // Optional metadata can be absent (zero) or broken on a vendor driver. Keep the
                // camera available and leave that size at the compatible rate when lookup fails.
                val minimumFrameDurations = sizes.mapNotNull { size ->
                    runCatching { streamMap?.getOutputMinFrameDuration(SurfaceTexture::class.java, Size(size.width, size.height)) }
                        .getOrNull()?.takeIf { it > 0 }?.let { size to it }
                }.toMap()
                // AE ranges are camera-wide capabilities, not a promise that every size supports every rate.
                val fps = characteristics.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
                    ?.map { NativeCameraFpsRange(it.lower, it.upper) }
                    .orEmpty().filter { it.min > 0 && it.max >= it.min }.distinct()
                    .sortedWith(compareBy<NativeCameraFpsRange> { it.max }.thenBy { it.min })
                val pixelArray = characteristics.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE)
                    ?.let { NativeCameraSize(it.width, it.height) }
                val activeArray = characteristics.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)
                    ?.let { NativeCameraSize(it.width(), it.height()) }
                val unavailable = NativeCameraCompatibility.unavailableSizes(
                    NativeCameraFirmware(Build.MANUFACTURER, Build.MODEL, Build.DEVICE, Build.HARDWARE,
                        Build.BOARD, Build.VERSION.SDK_INT, Build.VERSION.RELEASE, Build.FINGERPRINT),
                    id, pixelArray, activeArray, sizes,
                )
                NativeCameraDevice(id, facing, sizes = sizes, fpsRanges = fps, unavailableSizes = unavailable,
                    minimumFrameDurationsNs = minimumFrameDurations)
            } catch (_: SecurityException) {
                denied = true
                null
            } catch (_: CameraAccessException) {
                null // A hot-unplug may happen between listing the ID and reading its characteristics.
            } catch (_: IllegalArgumentException) {
                null
            }
        }
        val error = when {
            devices.isNotEmpty() || ids.isEmpty() -> null
            denied -> "请允许摄像头权限"
            else -> "摄像头暂不可用，请刷新重试"
        }
        return NativeCameraSnapshot(NativeCameraSelection.ordered(devices), usbCount, error)
    }

    private fun usbVideoDeviceCount(): Int {
        val manager = context.getSystemService(Context.USB_SERVICE) as? UsbManager ?: return 0
        return try {
            manager.deviceList.values.count { device ->
                device.deviceClass == UsbConstants.USB_CLASS_VIDEO ||
                    (0 until device.interfaceCount).any { device.getInterface(it).interfaceClass == UsbConstants.USB_CLASS_VIDEO }
            }
        } catch (_: SecurityException) {
            0 // USB descriptor access is optional diagnostic information, not camera authorization.
        }
    }
}
