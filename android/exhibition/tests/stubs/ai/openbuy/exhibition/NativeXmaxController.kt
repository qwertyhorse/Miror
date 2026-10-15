package ai.openbuy.exhibition

import ai.xmax.sdk.CameraPosition
import java.io.IOException

/** Records SDK calls only. No SDK, camera, RTC, or provider HTTP implementation is loaded. */
class NativeXmaxController(private val events: MutableList<String>) {
    var onFirstFrame: (() -> Unit)? = null
    var onError: ((String) -> Unit)? = null
    var failConnect = false
    var failGenerate = false
    var connectedImage: ByteArray? = null
    var connectedPosition: CameraPosition? = null
    var connectedCameraDeviceId: String? = null
    var generatedPrompt: String? = null
    var generatedReference: String? = null
    suspend fun connect(token: String, region: String, model: String,
                        position: CameraPosition = CameraPosition.BACK, image: ByteArray? = null,
                        cameraDeviceId: String? = null): String {
        check(token == "tk-fixture" && region == "cn" && model == "x2.0")
        events.add("connect")
        connectedImage = image
        connectedPosition = position
        connectedCameraDeviceId = cameraDeviceId
        if (failConnect) throw IOException("连接失败 tk-fixture https://supplier-fixture.invalid/?secret=fixture")
        return "ums-fixture"
    }

    suspend fun generate(prompt: String, refUrl: String? = null) {
        events.add("generate")
        if (failGenerate) throw IOException("生成结果未确认")
        generatedPrompt = prompt
        generatedReference = refUrl
        events.add("remote-frame")
        onFirstFrame?.invoke()
    }

    suspend fun disconnect() { events.add("disconnect") }
}
