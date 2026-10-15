package ai.openbuy.exhibition

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream

/** Offline JavaScript state machine only. Pixels, inference and network never enter this WebView. */
@SuppressLint("SetJavaScriptEnabled")
internal class NativeGestureBridge(
    context: Context,
    private val onState: (JSONObject) -> Unit,
    private val onError: (String) -> Unit = {},
) {
    private val gate = NativeGestureFrameGate()
    private val webView = WebView(context)
    private val handler = Handler(Looper.getMainLooper())
    private var ready = false
    private var closed = false
    private var blocked = false
    private var options = "{}"
    private var setupEpoch = 0L
    private var pageLoaded = false

    init {
        checkMainThread()
        webView.settings.apply {
            javaScriptEnabled = true
            blockNetworkLoads = true
            blockNetworkImage = true
            allowFileAccess = false
            allowContentAccess = false
            domStorageEnabled = false
            javaScriptCanOpenWindowsAutomatically = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
                WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))

            override fun onPageFinished(view: WebView, url: String) {
                if (closed) return
                pageLoaded = true
                initialize()
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                close()
                onError("手势识别未能启动，请重试。")
                return true
            }
        }
        try {
            val script = context.assets.open("exhibition-gestures/detector.js").bufferedReader().use { it.readText() }
            // Script is generated entirely from project source, never remote input.
            webView.loadDataWithBaseURL("https://native-gesture.invalid/", "<!doctype html><meta charset=\"utf-8\"><script>$script</script>", "text/html", "UTF-8", null)
        } catch (_: Exception) { fail() }
    }

    private fun checkMainThread() {
        check(Looper.myLooper() == Looper.getMainLooper()) { "NativeGestureBridge requires the main thread" }
    }

    private fun initialize() {
        val current = ++setupEpoch
        evaluate("(NativeGestureRuntime.configure($options),NativeGestureRuntime.setBlocked($blocked))") { state ->
            if (closed || current != setupEpoch) return@evaluate
            if (state == null) { fail(); return@evaluate }
            ready = true
            onState(state)
        }
    }

    fun configure(value: JSONObject) {
        checkMainThread()
        val next = value.toString()
        if (closed || next == options) return
        options = next
        gate.invalidate()
        if (ready) evaluate("NativeGestureRuntime.configure($options)") { if (it == null) fail() }
        else if (pageLoaded) initialize()
    }

    fun setBlocked(value: Boolean) {
        checkMainThread()
        if (closed || blocked == value) return
        blocked = value
        gate.invalidate()
        if (ready) evaluate("NativeGestureRuntime.setBlocked($blocked)") { if (it == null) fail() }
        else if (pageLoaded) initialize()
    }

    fun accept(timestampMs: Long, hands: JSONArray, aspectRatio: Double = 1.0): Boolean {
        checkMainThread()
        if (closed || !ready || !aspectRatio.isFinite() || aspectRatio <= 0) return false
        val ticket = gate.begin(timestampMs) ?: return false
        val frame = JSONObject().put("timestamp", timestampMs).put("hands", hands).put("poses", JSONArray()).put("aspectRatio", aspectRatio)
        val timeout = Runnable { if (gate.complete(ticket)) fail() }
        handler.postDelayed(timeout, 2_000L)
        evaluate("NativeGestureRuntime.push($frame)") { state ->
            handler.removeCallbacks(timeout)
            if (!gate.complete(ticket)) return@evaluate
            if (state == null) { fail(); return@evaluate }
            onState(state)
        }
        return true
    }

    fun reset() {
        checkMainThread()
        if (closed) return
        gate.invalidate(resetTimestamp = true)
        if (ready) evaluate("NativeGestureRuntime.reset()") { if (it == null) fail() }
        else if (pageLoaded) initialize()
    }

    /** Recover a failed evaluation without creating a newly armed detector. */
    fun retry() {
        checkMainThread()
        if (closed) return
        ready = false
        gate.invalidate(resetTimestamp = true)
        if (pageLoaded) initialize()
    }

    private fun evaluate(expression: String, result: (JSONObject?) -> Unit) {
        if (closed) return
        // JSON.stringify makes every evaluateJavascript result unambiguous across old providers.
        val source = "(function(){try{return JSON.stringify((function(){return $expression;})());}catch(e){return null;}})()"
        webView.evaluateJavascript(source) { encoded ->
            if (closed) return@evaluateJavascript
            val parsed = try {
                if (encoded == "null" || encoded == null) null else JSONObject(JSONArray("[$encoded]").getString(0))
            } catch (_: Exception) { null }
            result(parsed)
        }
    }

    private fun fail() {
        if (closed) return
        ready = false
        gate.invalidate()
        onError("手势识别未能启动，请重试。")
    }

    fun close() {
        checkMainThread()
        if (closed) return
        closed = true
        ready = false
        setupEpoch++
        gate.close()
        handler.removeCallbacksAndMessages(null)
        webView.stopLoading()
        webView.destroy()
    }
}
