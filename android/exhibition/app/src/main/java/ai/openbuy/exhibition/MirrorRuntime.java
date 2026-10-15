package ai.openbuy.exhibition;

/** Browser RTC and inference requirements apply only to the complete web terminal. */
final class MirrorRuntime {
    static final int MIN_WEBVIEW_MAJOR = 111;

    static boolean supportsWeb(String version) {
        if (version == null) return false;
        try { return Integer.parseInt(version.split("\\.")[0]) >= MIN_WEBVIEW_MAJOR; }
        catch (NumberFormatException ignored) { return false; }
    }

    static boolean supportsWeb() {
        android.content.pm.PackageInfo provider = DeviceDiagnostics.currentProvider();
        return provider != null && supportsWeb(provider.versionName);
    }
}
