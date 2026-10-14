package ai.openbuy.exhibition;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.json.JSONException;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final int MIN_WEBVIEW_MAJOR = 111;
    private static final int CAMERA_PERMISSION = 41;
    private static final int PURPLE = Color.rgb(116, 82, 214);
    private final Handler handler = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WebView webView;
    private LinearLayout status;
    private TextView statusTitle;
    private TextView statusBody;
    private Button retry;
    private Button diagnostics;
    private TextView deviceButton;
    private SharedPreferences preferences;
    private volatile String screenUrl;
    private volatile String loadedPageUrl;
    private volatile String terminalId;
    private volatile String terminalToken;
    private boolean failed;
    private boolean destroyed;
    private PermissionRequest pendingCameraRequest;
    private boolean cameraPermissionPromptActive;
    private String lastPageStatus = "尚未加载";
    private final Runnable loadTimeout = () -> showError("页面加载超时", "请确认设备与后台电脑连接在同一网络，然后重试。");

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences("exhibition-device", MODE_PRIVATE);
        initializeTerminalIdentity();
        try {
            screenUrl = UrlPolicy.cameraScreenUrl(preferences.getString("screen-url", UrlPolicy.DEFAULT_URL));
        } catch (IllegalArgumentException ignored) {
            screenUrl = UrlPolicy.DEFAULT_URL;
        }
        preferences.edit().putString("screen-url", screenUrl).apply();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(247, 245, 251));
        setContentView(root);
        createStatusView();
        createDeviceButton();
        enterFullscreen();
        loadScreen();
    }

    private void initializeTerminalIdentity() {
        String savedId = preferences.getString("terminal-id", null);
        String savedToken = preferences.getString("terminal-token", null);
        if (savedId == null || savedId.isEmpty() || savedToken == null || savedToken.isEmpty()) {
            savedId = "terminal-" + UUID.randomUUID();
            savedToken = UUID.randomUUID().toString() + UUID.randomUUID();
            // Commit both together before exposing the identity to any WebView request.
            if (!preferences.edit().putString("terminal-id", savedId).putString("terminal-token", savedToken).commit()) return;
        }
        terminalId = savedId;
        terminalToken = savedToken;
    }

    private WebResourceResponse nativeIdentityResponse() {
        try {
            if (terminalId == null || terminalToken == null) throw new JSONException("identity unavailable");
            JSONObject body = new JSONObject();
            body.put("native", true);
            body.put("terminalId", terminalId);
            body.put("token", terminalToken);
            body.put("label", terminalLabel());
            body.put("platform", "android");
            body.put("cameraEngine", "web");
            return nativeResponse(200, "OK", body.toString());
        } catch (JSONException error) {
            return nativeResponse(503, "Unavailable", "{\"native\":true,\"error\":\"设备标识暂时不可用，请重启应用后重试。\"}");
        }
    }

    private String terminalLabel() {
        String label = ((Build.MANUFACTURER == null ? "" : Build.MANUFACTURER) + " "
            + (Build.MODEL == null ? "" : Build.MODEL)).replaceAll("[\\p{Cc}\\p{Cf}]", "").trim();
        if (label.length() > 80) {
            int end = Character.isHighSurrogate(label.charAt(79)) ? 79 : 80;
            label = label.substring(0, end).trim();
        }
        return label.isEmpty() ? "安卓镜端" : label;
    }

    private WebResourceResponse nativeResponse(int code, String reason, String body) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store, max-age=0");
        headers.put("Pragma", "no-cache");
        headers.put("X-Content-Type-Options", "nosniff");
        return new WebResourceResponse("application/json", "UTF-8", code, reason, headers,
            new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
    }

    private void createStatusView() {
        status = new LinearLayout(this);
        status.setOrientation(LinearLayout.VERTICAL);
        status.setGravity(Gravity.CENTER);
        status.setPadding(dp(32), dp(32), dp(32), dp(32));
        status.setBackgroundColor(Color.rgb(247, 245, 251));
        statusTitle = new TextView(this);
        statusTitle.setTextColor(PURPLE);
        statusTitle.setTextSize(26);
        statusTitle.setTypeface(null, Typeface.BOLD);
        statusTitle.setGravity(Gravity.CENTER);
        status.addView(statusTitle);
        statusBody = new TextView(this);
        statusBody.setTextColor(Color.rgb(91, 85, 110));
        statusBody.setTextSize(17);
        statusBody.setGravity(Gravity.CENTER);
        statusBody.setPadding(0, dp(20), 0, dp(24));
        status.addView(statusBody);
        retry = new Button(this);
        retry.setText("重新连接");
        retry.setOnClickListener(view -> loadScreen());
        status.addView(retry, new LinearLayout.LayoutParams(dp(200), dp(56)));
        diagnostics = new Button(this);
        diagnostics.setText("查看设备信息");
        diagnostics.setOnClickListener(view -> showDiagnostics());
        status.addView(diagnostics, new LinearLayout.LayoutParams(dp(200), dp(56)));
        root.addView(status, new FrameLayout.LayoutParams(-1, -1));
    }

    private void createDeviceButton() {
        deviceButton = new TextView(this);
        deviceButton.setText("设备");
        deviceButton.setTextSize(12);
        deviceButton.setTextColor(PURPLE);
        deviceButton.setGravity(Gravity.CENTER);
        deviceButton.setBackgroundColor(Color.argb(224, 247, 245, 251));
        deviceButton.setContentDescription("设备设置，长按打开");
        deviceButton.setFocusable(true);
        deviceButton.setOnClickListener(view -> Toast.makeText(this, "长按“设备”可设置展台网址", Toast.LENGTH_SHORT).show());
        deviceButton.setOnLongClickListener(view -> { showSettings(); return true; });
        // Keep native settings clear of the page's top-right camera controls.
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(dp(52), dp(44), Gravity.BOTTOM | Gravity.START);
        params.bottomMargin = dp(8);
        params.setMarginStart(dp(8));
        root.addView(deviceButton, params);
    }

    @SuppressWarnings("deprecation")
    private boolean ensureWebView() {
        if (webView != null) return true;
        PackageInfo provider = DeviceDiagnostics.currentProvider();
        int major = 0;
        if (provider != null && provider.versionName != null) {
            try { major = Integer.parseInt(provider.versionName.split("\\.")[0]); }
            catch (NumberFormatException ignored) { }
        }
        if (major < MIN_WEBVIEW_MAJOR) {
            showError("请更新系统 WebView", "本页面要求当前 WebView 提供程序为 " + MIN_WEBVIEW_MAJOR + " 或更高版本。\n当前版本："
                + (provider == null ? "未找到 WebView" : provider.versionName)
                + "\n点击“查看设备信息”，由工作人员核对厂商支持的更新方式。");
            return false;
        }
        try { webView = new WebView(this); }
        catch (RuntimeException error) {
            showError("系统 WebView 无法启动", "请联系设备供应商检查 WebView 组件，修复后重试。");
            return false;
        }
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSaveFormData(false);
        settings.setGeolocationEnabled(false);
        settings.setSupportZoom(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        webView.setBackgroundColor(Color.rgb(247, 245, 251));
        webView.setWebViewClient(new ScreenClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) { requestCamera(request); }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingCameraRequest == request) pendingCameraRequest = null;
            }
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                callback.invoke(origin, false, false);
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> result, FileChooserParams params) {
                result.onReceiveValue(null);
                return true;
            }
        });
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) ->
            Toast.makeText(this, "展台端不提供文件下载，请在工作人员后台操作", Toast.LENGTH_SHORT).show());
        root.addView(webView, 0, new FrameLayout.LayoutParams(-1, -1));
        return true;
    }

    private void loadScreen() {
        cancelPendingCameraRequest();
        handler.removeCallbacks(loadTimeout);
        if (destroyed || !ensureWebView()) return;
        webView.stopLoading();
        failed = false;
        showLoading();
        // Always load the configured screen; Back and retry never leave the exhibition.
        webView.loadUrl(screenUrl);
        handler.postDelayed(loadTimeout, 20000);
    }

    private void showLoading() {
        lastPageStatus = "正在加载";
        statusTitle.setText("正在连接试衣镜");
        statusBody.setText("OpenBuy.AI\n请稍候…");
        retry.setVisibility(View.GONE);
        diagnostics.setVisibility(View.GONE);
        status.setVisibility(View.VISIBLE);
    }

    private void showError(String title, String message) {
        if (destroyed) return;
        failed = true;
        lastPageStatus = title;
        handler.removeCallbacks(loadTimeout);
        if (webView != null) webView.stopLoading();
        statusTitle.setText(title);
        statusBody.setText(message + "\n\n" + screenUrl + "\n\n长按左下角“设备”可修改地址。");
        retry.setVisibility(View.VISIBLE);
        diagnostics.setVisibility(View.VISIBLE);
        status.setVisibility(View.VISIBLE);
    }

    private void showSettings() {
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(24), dp(8), dp(24), dp(8));
        TextView help = new TextView(this);
        help.setText("镜端地址");
        help.setTextSize(15);
        content.addView(help);
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(false);
        input.setText(screenUrl);
        input.setSelectAllOnFocus(true);
        content.addView(input, new LinearLayout.LayoutParams(-1, -2));
        Button diagnosticButton = new Button(this);
        diagnosticButton.setText("查看设备信息");
        diagnosticButton.setOnClickListener(view -> showDiagnostics());
        content.addView(diagnosticButton);
        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle("展台设备设置")
            .setView(content)
            .setNegativeButton("取消", null)
            .setNeutralButton("恢复默认", null)
            .setPositiveButton("保存并连接", null)
            .create();
        dialog.setOnShowListener(ignored -> {
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(view -> fillAddress(input, UrlPolicy.DEFAULT_URL));
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
                try {
                    String nextUrl = UrlPolicy.cameraScreenUrl(input.getText().toString());
                    screenUrl = nextUrl;
                    preferences.edit().putString("screen-url", screenUrl).apply();
                    if (webView != null) { webView.stopLoading(); webView.clearHistory(); }
                    dialog.dismiss();
                    loadScreen();
                } catch (IllegalArgumentException error) { input.setError(error.getMessage()); }
            });
        });
        dialog.setOnDismissListener(ignored -> enterFullscreen());
        dialog.show();
    }

    private void fillAddress(EditText input, String target) {
        try { input.setText(UrlPolicy.preserveMirror(target, input.getText().toString())); }
        catch (IllegalArgumentException ignored) { input.setText(UrlPolicy.preserveMirror(target, screenUrl)); }
    }

    private void showDiagnostics() {
        TextView report = new TextView(this);
        report.setText(DeviceDiagnostics.describe(this, MIN_WEBVIEW_MAJOR, screenUrl, lastPageStatus, webView != null));
        report.setTextColor(Color.rgb(55, 48, 72));
        report.setTextSize(15);
        report.setTextIsSelectable(true);
        report.setPadding(dp(24), dp(12), dp(24), dp(20));
        ScrollView scroll = new ScrollView(this);
        scroll.addView(report);
        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle("设备诊断")
            .setView(scroll)
            .setPositiveButton("关闭", null)
            .setNeutralButton("刷新", null)
            .setNegativeButton("复制信息", null)
            .create();
        dialog.setOnShowListener(ignored -> {
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(view ->
                report.setText(DeviceDiagnostics.describe(this, MIN_WEBVIEW_MAJOR, screenUrl, lastPageStatus, webView != null)));
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener(view -> {
                ClipboardManager clipboard = getSystemService(ClipboardManager.class);
                if (clipboard != null) {
                    clipboard.setPrimaryClip(ClipData.newPlainText("OpenBuy 设备诊断", report.getText()));
                    Toast.makeText(this, "设备信息已复制", Toast.LENGTH_SHORT).show();
                }
            });
        });
        dialog.setOnDismissListener(ignored -> enterFullscreen());
        dialog.show();
    }

    @SuppressWarnings("deprecation")
    private void enterFullscreen() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) enterFullscreen();
    }

    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() {
        Toast.makeText(this, "展台保持在体验页面，长按左下角“设备”可设置", Toast.LENGTH_SHORT).show();
        enterFullscreen();
    }

    @Override protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        enterFullscreen();
    }

    @Override protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override protected void onDestroy() {
        destroyed = true;
        cancelPendingCameraRequest();
        handler.removeCallbacksAndMessages(null);
        if (webView != null) {
            root.removeView(webView);
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private void requestCamera(PermissionRequest request) {
        boolean videoRequested = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) videoRequested = true;
        }
        if (destroyed || failed || !videoRequested || cameraPermissionPromptActive || pendingCameraRequest != null
                || !UrlPolicy.canUseCamera(screenUrl, request.getOrigin().toString())
                || webView == null || !UrlPolicy.sameOrigin(screenUrl, webView.getUrl())) {
            request.deny();
            return;
        }
        pendingCameraRequest = request;
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            finishCameraPermission(true);
        } else {
            cameraPermissionPromptActive = true;
            requestPermissions(new String[] { Manifest.permission.CAMERA }, CAMERA_PERMISSION);
        }
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != CAMERA_PERMISSION) return;
        cameraPermissionPromptActive = false;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        finishCameraPermission(granted);
        if (!granted && !destroyed) Toast.makeText(this, "摄像头未授权。可在系统应用权限中允许相机后重新开始。", Toast.LENGTH_LONG).show();
    }

    private void finishCameraPermission(boolean granted) {
        PermissionRequest request = pendingCameraRequest;
        pendingCameraRequest = null;
        if (request == null) return;
        if (granted && !destroyed && !failed && webView != null
                && UrlPolicy.canUseCamera(screenUrl, request.getOrigin().toString())
                && UrlPolicy.sameOrigin(screenUrl, webView.getUrl())) {
            // Explicit subset: microphone and any future WebView resources stay denied.
            request.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
        } else request.deny();
    }

    private void cancelPendingCameraRequest() {
        PermissionRequest request = pendingCameraRequest;
        pendingCameraRequest = null;
        if (request != null) request.deny();
    }

    private void explainBlockedNavigation(String target) {
        showError("已拦截外部页面", "请检查镜端地址。");
    }

    private final class ScreenClient extends WebViewClient {
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String target = request.getUrl().toString();
            String cameraTarget = request.isForMainFrame() && "GET".equals(request.getMethod())
                ? UrlPolicy.trustedCameraNavigation(screenUrl, target) : null;
            if (cameraTarget != null && (!UrlPolicy.sameOrigin(screenUrl, target) || !cameraTarget.equals(target))) {
                cancelPendingCameraRequest();
                screenUrl = cameraTarget;
                preferences.edit().putString("screen-url", screenUrl).apply();
                if (!cameraTarget.equals(target)) { loadScreen(); return true; }
            }
            boolean allowed = UrlPolicy.sameOrigin(screenUrl, target);
            if (!allowed && request.isForMainFrame()) {
                explainBlockedNavigation(request.getUrl().toString());
            }
            return !allowed;
        }

        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            String target = request.getUrl().toString();
            if (UrlPolicy.isNativeIdentityEndpoint(target)) {
                String origin = null;
                for (Map.Entry<String, String> header : request.getRequestHeaders().entrySet()) {
                    if (header.getKey().equalsIgnoreCase("Origin")) { origin = header.getValue(); break; }
                }
                if (UrlPolicy.canReadNativeIdentity(screenUrl, loadedPageUrl, target, request.getMethod(), request.isForMainFrame(), origin)) {
                    return nativeIdentityResponse();
                }
                return nativeResponse(403, "Blocked", "{\"native\":false}");
            }
            if (request.isForMainFrame() ? UrlPolicy.sameOrigin(screenUrl, target) : UrlPolicy.canLoadSubresource(screenUrl, target)) return null;
            return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked",
                Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
        }

        @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            cancelPendingCameraRequest();
            loadedPageUrl = null;
            if (!UrlPolicy.sameOrigin(screenUrl, url)) {
                explainBlockedNavigation(url);
                return;
            }
            loadedPageUrl = url;
            handler.removeCallbacks(loadTimeout);
            if (!failed) handler.postDelayed(loadTimeout, 20000);
        }

        @Override public void onPageFinished(WebView view, String url) {
            handler.removeCallbacks(loadTimeout);
            if (!failed && UrlPolicy.sameOrigin(screenUrl, url)) {
                lastPageStatus = "页面加载完成（不代表摄像头或 XMAX 已通过）";
                status.setVisibility(View.GONE);
            }
        }

        @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showError("暂时无法连接试衣镜", "请检查网络连接、展台网址，以及后台电脑是否正在运行。");
        }

        @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame()) showError("展台页面暂时不可用", "服务器返回 HTTP " + response.getStatusCode() + "，请检查大屏路径或稍后重试。");
        }

        @Override public void onReceivedSslError(WebView view, SslErrorHandler sslHandler, SslError error) {
            sslHandler.cancel();
            showError("安全连接验证失败", "请检查 HTTPS 证书及设备时间，修复后重试。");
        }

        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            root.removeView(view);
            view.destroy();
            if (webView == view) webView = null;
            showError("显示组件已停止", "点击重新连接以重新创建显示页面。");
            return true;
        }
    }
}
