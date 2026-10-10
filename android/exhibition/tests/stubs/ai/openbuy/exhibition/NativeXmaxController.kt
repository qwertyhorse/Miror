package ai.openbuy.exhibition

import ai.xmax.sdk.CameraPosition
import java.io.IOException

/** Records SDK calls only. No SDK, camera, RTC, or provider HTTP implementation is loaded. */
class NativeXmaxController(private val events: MutableList<String>) {
    var onFirstFrame: (() -> Unit)? = null
    var onError: ((String) -> Unit)? = null
    var failConnect = false
    var connectedImage: ByteArray? = null
    var connectedPosition: CameraPosition? = null
    var generatedPrompt: String? = null
    var generatedReference: String? = null
    var uploadedBytes: ByteArray? = null
    var uploadedMime: String? = null

    suspend fun uploadReference(token: String, region: String, bytes: ByteArray, mime: String): String {
        check(token == "tk-fixture" && region == "cn")
        events.add("upload")
        uploadedBytes = bytes
        uploadedMime = mime
        return "https://supplier-fixture.invalid/reference.png"
    }

    suspend fun connect(token: String, region: String, model: String,
                        position: CameraPosition = CameraPosition.BACK, image: ByteArray? = null): String {
        check(token == "tk-fixture" && region == "cn" && model == "x2.0")
        events.add("connect")
        connectedImage = image
        connectedPosition = position
        if (failConnect) throw IOException("连接失败 tk-fixture https://supplier-fixture.invalid/?secret=fixture")
        return "ums-fixture"
    }

    suspend fun generate(prompt: String, refUrl: String? = null) {
        events.add("generate")
        generatedPrompt = prompt
        generatedReference = refUrl
        events.add("remote-frame")
        onFirstFrame?.invoke()
    }

    suspend fun disconnect() { events.add("disconnect") }
}
