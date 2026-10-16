package ai.openbuy.exhibition

import android.app.Activity
import android.app.Instrumentation
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.os.SystemClock
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Real legacy provider, Activity, detector and LAN transport. Camera/inference boundaries use isolated fixtures. */
class NativeGestureInstrumentation : Instrumentation() {
    private var arguments = Bundle()
    private val checks = mutableListOf<String>()

    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        this.arguments = arguments ?: Bundle()
        start()
    }

    override fun onStart() {
        val result = Bundle()
        try {
            val provider = main { WebView.getCurrentWebViewPackage()?.versionName.orEmpty() }
            require(provider.substringBefore('.').toInt() in 69..74) { "Expected real legacy WebView 69–74, received $provider" }
            verifyBridge()
            val fixtureUrl = arguments.getString("fixtureUrl")
            val controlUrl = arguments.getString("controlUrl")
            if (!fixtureUrl.isNullOrEmpty() && !controlUrl.isNullOrEmpty()) {
                verifyActivity(fixtureUrl, controlUrl, "local")
                verifyActivity(fixtureUrl, controlUrl, "linux")
            }
            result.putString("stream", "\n" + JSONObject().put("webView", provider).put("passed", JSONArray(checks)).toString(2) + "\n")
            finish(Activity.RESULT_OK, result)
        } catch (failure: Throwable) {
            result.putString("stream", "\nNative gesture instrumentation failed: ${failure.stackTraceToString()}\n")
            finish(Activity.RESULT_CANCELED, result)
        }
    }

    private fun verifyBridge() {
        val states = LinkedBlockingQueue<JSONObject>()
        val errors = LinkedBlockingQueue<String>()
        val bridge = main { NativeGestureBridge(targetContext, { states.add(JSONObject(it.toString())) }, errors::add) }
        fun state(): JSONObject = states.poll(5, TimeUnit.SECONDS) ?: error("Bridge did not return state: $errors")
        fun push(time: Long, hands: JSONArray = hands()): JSONObject {
            check(main { bridge.accept(time, hands, 1.0) }) { "Bridge rejected $time" }
            return state()
        }
        fun quiet(from: Long, to: Long, hands: JSONArray = hands()) {
            var at = from
            while (at <= to) { check(push(at, hands).isNull("event")) { "Replayed gesture at $at" }; at += 100 }
        }
        try {
            check(state().getString("operatorStatus") == "searching")
            main { bridge.configure(JSONObject().put("gestures", JSONArray().put("open_palm"))) }
            check(push(0).isNull("event"))
            check(push(310).getString("event") == "open_palm")
            quiet(410, 1010)
            checks.add("Actual offline legacy WebView loads; 0 → 310 ms confirms once")

            main { bridge.setBlocked(true) }
            quiet(1110, 1710)
            main { bridge.setBlocked(false) }
            quiet(1810, 2410)
            main { bridge.retry() }
            state()
            quiet(2510, 3110)
            checks.add("Busy completion and retry preserve a consumed held palm")

            main { bridge.setBlocked(true) }
            quiet(3210, 3910, JSONArray())
            main { bridge.setBlocked(false) }
            check(push(4010).isNull("event"))
            check(push(4320).getString("event") == "open_palm")
            checks.add("Release observed while busy enables a fresh post-busy presentation")

            // EvaluateJavascript is asynchronous: this real in-flight result must
            // be discarded even if its JavaScript task finishes after blocking.
            main { check(bridge.accept(4420, hands(), 1.0)); bridge.setBlocked(true) }
            check(states.poll(300, TimeUnit.MILLISECONDS) == null) { "Stale evaluation crossed busy boundary" }
            quiet(4520, 5120)
            checks.add("Actual late evaluateJavascript callback is discarded")
            check(errors.isEmpty()) { "Unexpected bridge errors: $errors" }
        } finally { main { bridge.close() } }
    }

    override fun callActivityOnStart(activity: Activity) {
        if (activity is NativeExhibitionActivity && !arguments.getString("fixtureUrl").isNullOrEmpty()) {
            // x86's vendor RTC cannot load libbytenn. Replace its ready boundary only;
            // never claim that this emulator verified a physical camera or cloud video.
            setField(activity, "cameraReady", true)
        }
        super.callActivityOnStart(activity)
    }

    private fun verifyActivity(fixtureUrl: String, controlUrl: String, mode: String) {
        val source = URL(controlUrl)
        require(source.protocol == "http" && source.host == "10.0.2.2") { "Activity tests require the emulator's isolated host fixture" }
        require(URL(fixtureUrl).host == "xuxin.local" && URL(fixtureUrl).port !in listOf(10101, 10202)) {
            "Never run this instrumentation against the live exhibition backend"
        }
        control(controlUrl, JSONObject().put("reset", true).put("commandDelayMs", 1200))
        uiAutomation.executeShellCommand("pm grant ${targetContext.packageName} android.permission.CAMERA").close()
        targetContext.getSharedPreferences("exhibition-device", Context.MODE_PRIVATE).edit()
            .putString("screen-url", fixtureUrl).putString("backend-ip", "10.0.2.2")
            .putBoolean("backend-ip-prefilled", false).putString("native-gesture-mode", mode).commit()
        val monitor = addMonitor(NativeExhibitionActivity::class.java.name, null, false)
        main { targetContext.startActivity(Intent(targetContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        val activity = waitForMonitorWithTimeout(monitor, 15_000) as? NativeExhibitionActivity
            ?: error("Legacy launcher did not route to NativeExhibitionActivity")
        try {
            await("bound Activity and $mode gesture runtime", 30_000) {
                main { field<Boolean>(activity, "cameraReady") && field<JSONObject?>(activity, "gestureState") != null }
            }
            checks.add("$mode: legacy launcher opens actual Activity; camera ready boundary is simulated")
            verifyMaterialCatalog(activity)
            var lastFeed = 0L
            fun feed(hand: JSONArray = hands()) {
                val wait = 110 - (SystemClock.elapsedRealtime() - lastFeed)
                if (wait > 0) Thread.sleep(wait)
                val timestamp = SystemClock.elapsedRealtime()
                lastFeed = timestamp
                if (mode == "local") {
                    val tracked = (0 until hand.length()).map { index ->
                        val item = hand.getJSONObject(index)
                        val points = item.getJSONArray("landmarks")
                        NativeTrackedHand(item.getString("handedness"), (0 until points.length()).map { point ->
                            val value = points.getJSONObject(point)
                            NativeHandPoint((1 - value.getDouble("x")).toFloat(), value.getDouble("y").toFloat(), 0f)
                        })
                    }
                    main {
                        val tracker = field<NativeHandTracker>(activity, "handTracker")
                        field<(NativeHandResult) -> Unit>(tracker, "onResult")(
                            NativeHandResult(tracked, timestamp, 1, 1, 480, 480))
                    }
                } else {
                    // The fixture replaces ML output, then runs the real server detector and epoch gates.
                    control(controlUrl, JSONObject().put("gestureHands", hand))
                    val released = java.util.concurrent.atomic.AtomicBoolean()
                    val frame = NativeCameraFrame(Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888), timestamp, 1, { true }) { released.set(true) }
                    val receiver = main { field<NativeXmaxController>(activity, "controller").onLocalFrame }
                    check(receiver != null)
                    receiver(frame)
                    // A frame crossing a busy/config boundary is intentionally dropped, never replayed.
                    await("remote camera ownership returned", 3_000) { released.get() }
                }
                if (mode == "local") await("$mode frame delivery", 3_000) {
                    main { field<JSONObject?>(activity, "gestureState")?.optLong("timestamp") == timestamp }
                }
            }
            fun observe(duration: Long, hand: JSONArray = hands()) {
                val end = SystemClock.elapsedRealtime() + duration
                while (SystemClock.elapsedRealtime() < end) { feed(hand); Thread.sleep(110) }
            }
            observe(500)
            check(status(controlUrl).getJSONArray("commands").length() == 0) { "$mode initially held palm bypassed release fence" }
            observe(700, JSONArray())
            control(controlUrl, JSONObject().put("clearRecords", true))
            main {
                val late = JSONObject().put("event", "open_palm").put("operatorStatus", "locked")
                    .put("blocked", false).put("timestamp", SystemClock.elapsedRealtime() - 850)
                activity.javaClass.getDeclaredMethod("onGestureState", JSONObject::class.java)
                    .apply { isAccessible = true }.invoke(activity, late)
            }
            Thread.sleep(100)
            check(status(controlUrl).getJSONArray("commands").length() == 0) { "$mode late JS/inference completion crossed final age gate" }
            checks.add("$mode: final Activity gate rejects an 850 ms old callback")
            feed(); Thread.sleep((310 - (SystemClock.elapsedRealtime() - lastFeed)).coerceAtLeast(0)); feed()
            await("first command") { status(controlUrl).getJSONArray("commands").length() == 1 }
            observe(1700) // Held through network busy and completion.
            check(status(controlUrl).getJSONArray("commands").length() == 1) { "Held palm repeated a request" }
            checks.add("$mode: actual Activity submits once; busy and completed request do not replay held palm")

            observe(700, JSONArray())
            feed(); Thread.sleep((310 - (SystemClock.elapsedRealtime() - lastFeed)).coerceAtLeast(0)); feed()
            await("second command") { status(controlUrl).getJSONArray("commands").length() == 2 }
            observe(250, hands(two = true))
            observe(650, JSONArray())
            await("second command completion") { status(controlUrl).optInt("pendingCommands") == 0 }
            Thread.sleep(200)
            check(status(controlUrl).getJSONArray("commands").length() == 2) { "Busy observations queued another request" }
            feed(); Thread.sleep((310 - (SystemClock.elapsedRealtime() - lastFeed)).coerceAtLeast(0)); feed()
            await("third fresh command") { status(controlUrl).getJSONArray("commands").length() == 3 }
            observe(1500)
            val final = status(controlUrl)
            check(final.getJSONArray("commands").length() == 3) { "Third presentation repeated" }
            check(final.getJSONArray("sessionAttempts").length() == 0) { "Gesture fixture attempted a paid generation" }
            checks.add("$mode: second hand and busy release recover; each fresh presentation makes exactly one select request")
            main {
                setField(activity, "gestureError", "fixture retry")
                field<MirrorKioskView>(activity, "kiosk").gestures.performClick()
            }
            await("$mode retry runtime") { main { field<JSONObject?>(activity, "gestureState") != null } }
            observe(600)
            check(status(controlUrl).getJSONArray("commands").length() == 3) { "$mode retry replayed a held palm" }
            observe(700, JSONArray())
            feed(); Thread.sleep((310 - (SystemClock.elapsedRealtime() - lastFeed)).coerceAtLeast(0)); feed()
            await("$mode release after retry") { status(controlUrl).getJSONArray("commands").length() == 4 }
            checks.add("$mode: retry requires release and accepts a fresh presentation")
        } finally {
            main { activity.finish() }
            removeMonitor(monitor)
        }
    }

    private fun verifyMaterialCatalog(activity: NativeExhibitionActivity) = main {
        val method = activity.javaClass.getDeclaredMethod("enabledLooks", JSONObject::class.java).apply { isAccessible = true }
        fun looks(value: JSONObject): List<JSONObject> = method.invoke(activity, value) as List<JSONObject>
        val snapshot = JSONObject().put("providerMode", "xmax").put("experienceMode", "free")
            .put("looks", JSONArray().put(JSONObject().put("id", "draft").put("mode", "free")))
            .put("enabledLookIds", JSONArray().put("draft"))
            .put("catalog", JSONObject().put("revision", 1).put("looks", JSONArray()
                .put(JSONObject().put("id", "available").put("name", "Available").put("mode", "free"))))
        check(looks(snapshot).single().getString("id") == "available")
        snapshot.put("looks", JSONArray()).put("enabledLookIds", JSONArray())
        check(looks(snapshot).single().getString("name") == "Available") { "Editable draft replaced the authoritative catalog" }
        val previous = field<JSONObject>(activity, "state")
        val current = JSONObject(previous.toString()).put("catalog", JSONObject().put("revision", 1)
            .put("looks", JSONArray(previous.getJSONArray("looks").toString())))
        val render = activity.javaClass.getDeclaredMethod("render").apply { isAccessible = true }
        setField(activity, "state", current); render.invoke(activity)
        val firstScope = field<String>(activity, "gestureScope")
        current.getJSONObject("catalog").put("revision", 2); render.invoke(activity)
        check(field<String>(activity, "gestureScope") != firstScope) { "Catalog revision did not invalidate gesture scope" }
        setField(activity, "state", previous); render.invoke(activity)
        checks.add("Backend catalog drives available choices; catalog revision invalidates gesture scope")
    }

    private fun hands(two: Boolean = false): JSONArray {
        val palm = arrayOf(0.0 to 0.0, -.04 to -.05, -.09 to -.09, -.12 to -.14, -.16 to -.17,
            -.06 to -.17, -.065 to -.29, -.07 to -.37, -.075 to -.44,
            0.0 to -.19, 0.0 to -.32, 0.0 to -.41, 0.0 to -.49,
            .06 to -.17, .065 to -.29, .07 to -.37, .075 to -.44,
            .115 to -.13, .13 to -.23, .14 to -.3, .15 to -.36)
        fun hand(x: Double): JSONObject = JSONObject().put("handedness", "Left").put("landmarks", JSONArray().apply {
            palm.forEach { put(JSONObject().put("x", x + it.first * .5).put("y", .42 + it.second * .5)) }
        })
        return JSONArray().put(hand(.3)).apply { if (two) put(hand(.7)) }
    }

    private fun await(label: String, timeout: Long = 8_000, condition: () -> Boolean) {
        val until = SystemClock.elapsedRealtime() + timeout
        while (!condition()) { check(SystemClock.elapsedRealtime() < until) { "Timeout: $label" }; Thread.sleep(30) }
    }

    private fun status(base: String) = request("$base/status")
    private fun control(base: String, value: JSONObject) = request("$base/control", value)
    private fun request(url: String, value: JSONObject? = null): JSONObject {
        val connection = URL(url).openConnection(java.net.Proxy.NO_PROXY) as HttpURLConnection
        connection.connectTimeout = 3_000; connection.readTimeout = 3_000
        try {
            if (value != null) {
                connection.requestMethod = "POST"; connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(value.toString().toByteArray()) }
            }
            check(connection.responseCode == 200) { "Isolated fixture returned ${connection.responseCode}" }
            return JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
        } finally { connection.disconnect() }
    }

    private fun setField(owner: Any, name: String, value: Any?) {
        owner.javaClass.getDeclaredField(name).apply { isAccessible = true }.set(owner, value)
    }

    @Suppress("UNCHECKED_CAST")
    private fun <T> field(owner: Any, name: String): T = owner.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(owner) as T
    private fun <T> main(block: () -> T): T {
        val value = AtomicReference<T>()
        val failure = AtomicReference<Throwable>()
        runOnMainSync { try { value.set(block()) } catch (error: Throwable) { failure.set(error) } }
        failure.get()?.let { throw it }
        return value.get()
    }
}
