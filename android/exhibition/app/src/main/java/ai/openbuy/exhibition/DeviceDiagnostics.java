package ai.openbuy.exhibition;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Process;
import android.util.DisplayMetrics;
import android.webkit.WebView;

/** Local-only diagnostic text: no camera, network probe, device ID, or upload. */
final class DeviceDiagnostics {
    private DeviceDiagnostics() { }

    static PackageInfo currentProvider() {
        try { return WebView.getCurrentWebViewPackage(); }
        catch (RuntimeException unavailable) { return null; }
    }

    static String describe(Context context, int minimumWebView, String screenUrl,
                           String pageStatus, boolean webViewCreated) {
        StringBuilder result = new StringBuilder();
        try {
            PackageInfo app = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            result.append("试衣镜 App：").append(app.versionName).append("（").append(app.getLongVersionCode()).append("）\n");
        } catch (PackageManager.NameNotFoundException impossible) {
            result.append("试衣镜 App：版本无法读取\n");
        }
        result.append("系统：Android ").append(Build.VERSION.RELEASE)
            .append(" / API ").append(Build.VERSION.SDK_INT)
            .append("\n厂商：").append(Build.MANUFACTURER)
            .append("\n品牌 / 型号：").append(Build.BRAND).append(" / ").append(Build.MODEL)
            .append("\n固件版本：").append(Build.DISPLAY)
            .append("\n构建类型：").append(Build.TYPE)
            .append("\n安全补丁：").append(Build.VERSION.SECURITY_PATCH)
            .append("\n系统 ABI：").append(String.join(", ", Build.SUPPORTED_ABIS))
            .append("\nApp 进程：").append(Process.is64Bit() ? "64 位" : "32 位");
        DisplayMetrics metrics = context.getResources().getDisplayMetrics();
        result.append("\n当前窗口：").append(metrics.widthPixels).append(" × ").append(metrics.heightPixels)
            .append(" px / ").append(metrics.densityDpi).append(" dpi");

        PackageInfo provider = currentProvider();
        result.append("\n\n当前 WebView 提供程序\n");
        if (provider == null) result.append("无法读取 / 系统未提供有效 WebView\n");
        else {
            result.append("包名：").append(provider.packageName)
                .append("\n版本：").append(provider.versionName)
                .append("\n版本代码：").append(provider.getLongVersionCode());
            if (provider.applicationInfo != null) {
                int flags = provider.applicationInfo.flags;
                result.append("\n系统预装：").append((flags & ApplicationInfo.FLAG_SYSTEM) != 0 ? "是" : "否")
                    .append("\n已安装预装应用更新：").append((flags & ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0 ? "是" : "否");
            }
            result.append("\n");
        }
        result.append("当前页面最低要求：WebView ").append(minimumWebView).append("+\n")
            .append("网页组件：").append(webViewCreated ? "已创建" : "未创建")
            .append("\n最近页面状态：").append(pageStatus)
            .append("\n配置站点：").append(origin(screenUrl))
            .append("\n相机权限：").append(context.checkSelfPermission(android.Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED ? "已允许" : "未允许");
        result.append("\n\n此页只读取设备信息，不会测试网络、开启摄像头或上传数据。")
            .append("\n是否能升级 WebView 取决于厂商固件允许的包名、签名和系统 ABI；仅安装浏览器不等于更新本 App 的 WebView。")
            .append("\n请将此页信息交给工作人员核对更新来源。完成更新后重新打开 App，再确认实际提供程序版本。");
        return result.toString();
    }

    private static String origin(String address) {
        if (address == null) return "未配置";
        Uri uri = Uri.parse(address);
        String host = uri.getHost();
        if (host == null) return "无法读取";
        if (host.contains(":")) host = "[" + host + "]";
        return uri.getScheme() + "://" + host + (uri.getPort() < 0 ? "" : ":" + uri.getPort());
    }
}
