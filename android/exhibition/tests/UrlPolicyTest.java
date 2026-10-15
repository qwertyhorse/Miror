package ai.openbuy.exhibition;

/** Runs with javac/java only: no Android SDK, Gradle, JUnit or network required. */
public final class UrlPolicyTest {
    private static int checks;
    private static final String HTTP_URL = "http://xuxin.local:10200/v1.1/exhibition/screen";

    public static void main(String[] args) {
        equal(UrlPolicy.CAMERA_URL, UrlPolicy.DEFAULT_URL);
        equal("https://xuxin.local:10202/v1.1/exhibition/screen", UrlPolicy.DEFAULT_URL);
        equal(UrlPolicy.DEFAULT_URL, UrlPolicy.migrateDefaultScreenUrl(null));
        equal(UrlPolicy.DEFAULT_URL + "?mirror=east&mode=touch#drawer",
            UrlPolicy.migrateDefaultScreenUrl("https://xuminghong.local:10202/v1.1/exhibition/screen?mirror=east&mode=touch#drawer"));
        equal(UrlPolicy.DEFAULT_URL + "?mirror=display%2F2#drawer",
            UrlPolicy.migrateDefaultScreenUrl("http://xuminghong.local:10200/?mirror=display%2F2#drawer"));
        equal("https://custom.local:10202/v1.1/exhibition/screen?mirror=east",
            UrlPolicy.migrateDefaultScreenUrl("https://custom.local:10202/v1.1/exhibition/screen?mirror=east"));
        equal("https://xuminghong.local:8443/v1.1/exhibition/screen",
            UrlPolicy.migrateDefaultScreenUrl("https://xuminghong.local:8443/v1.1/exhibition/screen"));
        equal("https://xuminghong.local:10202/custom/screen",
            UrlPolicy.migrateDefaultScreenUrl("https://xuminghong.local:10202/custom/screen"));
        equal("https://xuminghong.local:10202/v1.1/exhibition/screen",
            UrlPolicy.migrateDefaultScreenUrl("http://xuminghong.local:10101/v1.1/exhibition/screen"));
        truth(UrlPolicy.shouldClearLegacyFallback(null, "192.168.63.54", true));
        truth(UrlPolicy.shouldClearLegacyFallback("https://xuminghong.local:10202/v1.1/exhibition/screen?mirror=east", "192.168.63.54", true));
        falsity(UrlPolicy.shouldClearLegacyFallback(UrlPolicy.DEFAULT_URL, "192.168.63.54", true));
        falsity(UrlPolicy.shouldClearLegacyFallback("https://custom.local:10202/v1.1/exhibition/screen", "192.168.63.54", true));
        falsity(UrlPolicy.shouldClearLegacyFallback(null, "192.168.63.140", true));
        falsity(UrlPolicy.shouldClearLegacyFallback(null, "192.168.63.54", false));
        falsity(UrlPolicy.shouldClearLegacyFallback("invalid url", "192.168.63.54", true));
        equal(UrlPolicy.CAMERA_URL + "?mirror=east#drawer", UrlPolicy.cameraScreenUrl("http://xuxin.local:10101/?mirror=east#drawer"));
        equal(UrlPolicy.CAMERA_URL, UrlPolicy.trustedCameraNavigation("http://xuxin.local:10101/v1.1/exhibition/screen", UrlPolicy.CAMERA_URL));
        truth(UrlPolicy.trustedCameraNavigation("http://other.local:10101/v1.1/exhibition/screen", UrlPolicy.CAMERA_URL) == null);
        equal(UrlPolicy.CAMERA_URL + "?mirror=east&mode=touch#drawer", UrlPolicy.cameraScreenUrl(HTTP_URL + "?mirror=east&mode=touch#drawer"));
        equal(UrlPolicy.CAMERA_URL, UrlPolicy.cameraScreenUrl("xuxin.local:10200"));
        equal("https://192.168.10.25:10202/v1.1/exhibition/screen?mirror=east", UrlPolicy.cameraScreenUrl("http://192.168.10.25:10200/?mirror=east"));
        equal("https://[fd12::42]:10202/v1.1/exhibition/screen#drawer", UrlPolicy.cameraScreenUrl("http://[fd12::42]:10200/v1.1/exhibition/screen/#drawer"));
        equal(UrlPolicy.CAMERA_URL + "?mirror=east", UrlPolicy.cameraScreenUrl(UrlPolicy.CAMERA_URL + "?mirror=east"));
        equal("http://xuxin.local:10200/v1.1/exhibition/control", UrlPolicy.cameraScreenUrl("http://xuxin.local:10200/v1.1/exhibition/control"));
        equal("http://xuxin.local:10201/v1.1/exhibition/screen", UrlPolicy.cameraScreenUrl("http://xuxin.local:10201/v1.1/exhibition/screen"));
        equal("https://demo.example.com/custom/screen#drawer", UrlPolicy.cameraScreenUrl("https://demo.example.com/custom/screen#drawer"));
        equal(UrlPolicy.CAMERA_URL + "?mirror=east#drawer", UrlPolicy.trustedCameraNavigation(HTTP_URL, UrlPolicy.CAMERA_URL + "?mirror=east#drawer"));
        equal(UrlPolicy.CAMERA_URL + "?mirror=east#drawer", UrlPolicy.trustedCameraNavigation(UrlPolicy.CAMERA_URL, HTTP_URL + "?mirror=east#drawer"));
        for (String target : new String[] { "https://evil.local:10202/v1.1/exhibition/screen", "https://xuxin.local.evil.local:10202/v1.1/exhibition/screen",
                "https://xuxin.local:10201/v1.1/exhibition/screen", "https://xuxin.local:10200/v1.1/exhibition/screen",
                "http://xuxin.local:10202/v1.1/exhibition/screen", "https://xuxin.local:10202/v1.1/exhibition/control",
                "https://xuxin.local:10202/v1.1/exhibition/%73creen", "file:///v1.1/exhibition/screen" }) {
            truth(UrlPolicy.trustedCameraNavigation(HTTP_URL, target) == null);
        }
        truth(UrlPolicy.trustedCameraNavigation("https://example.com:10202/v1.1/exhibition/screen", "http://example.com:10200/v1.1/exhibition/screen") == null);
        truth(UrlPolicy.trustedCameraNavigation("http://xuxin.local:10200/v1.1/exhibition/control", UrlPolicy.CAMERA_URL) == null);
        equal(HTTP_URL, UrlPolicy.normalizeScreenUrl(" xuxin.local:10200 "));
        equal(HTTP_URL, UrlPolicy.normalizeScreenUrl("http://xuxin.local:10200/"));
        equal("http://192.168.10.25:10200/v1.1/exhibition/screen", UrlPolicy.normalizeScreenUrl("192.168.10.25:10200"));
        equal("https://demo.example.com/custom/screen?mode=touch", UrlPolicy.normalizeScreenUrl("HTTPS://DEMO.EXAMPLE.COM/custom/screen?mode=touch"));
        equal("http://[fd12::42]:10200/v1.1/exhibition/screen", UrlPolicy.normalizeScreenUrl("http://[fd12::42]:10200"));
        equal("http://display.lan/v1.1/exhibition/screen", UrlPolicy.normalizeScreenUrl("display.lan"));
        equal("http://display/v1.1/exhibition/screen", UrlPolicy.normalizeScreenUrl("display"));
        equal(HTTP_URL + "?mirror=mirror-east", UrlPolicy.normalizeScreenUrl("xuxin.local:10200/?mirror=mirror-east"));
        equal(UrlPolicy.CAMERA_URL + "?mirror=mirror-east", UrlPolicy.preserveMirror(UrlPolicy.CAMERA_URL, HTTP_URL + "?mirror=mirror-east"));
        equal(UrlPolicy.CAMERA_URL + "?view=full&mirror=mirror-east#drawer", UrlPolicy.preserveMirror(UrlPolicy.CAMERA_URL + "?view=full#drawer", HTTP_URL + "?mirror=mirror-east#old"));
        equal(HTTP_URL + "?mirror=mirror-east", UrlPolicy.preserveMirror(HTTP_URL, UrlPolicy.CAMERA_URL + "?mirror=mirror-east"));
        equal(UrlPolicy.CAMERA_URL + "?mirror=display%2F2", UrlPolicy.preserveMirror(UrlPolicy.CAMERA_URL, "http://192.168.1.5:10200/?mode=touch&mirror=display%2F2"));
        equal(UrlPolicy.CAMERA_URL + "?view=full&mirror=mirror-east", UrlPolicy.preserveMirror(UrlPolicy.CAMERA_URL + "?mirror=default&view=full", HTTP_URL + "?mirror=mirror-east"));
        equal(UrlPolicy.CAMERA_URL + "?%6Dirror=mirror-east", UrlPolicy.preserveMirror(UrlPolicy.CAMERA_URL, HTTP_URL + "?%6Dirror=mirror-east&mirror=default"));
        equal(UrlPolicy.CAMERA_URL, UrlPolicy.preserveMirror(UrlPolicy.CAMERA_URL, HTTP_URL));
        rejected("");
        rejected("file:///etc/passwd");
        rejected("intent://screen#Intent;scheme=http;end");
        rejected("javascript:alert(1)");
        rejected("http://xuxin.local:0");
        rejected("http://xuxin.local:99999");
        rejected("http://xuxin.local:");
        rejected("http://user:password@xuxin.local:10200");
        rejected("http://xuxin.local:10200\\@evil.local/");
        rejected("http://xuxin.local:10200/\nfile");
        rejected("http://example.com/");
        rejected("http://8.8.8.8/");
        rejected("http://192.168.1.999/");
        rejected("http://192.168.001.5/");
        rejected("http://3232235777/");
        rejected("http://172.32.1.2/");
        truth(UrlPolicy.sameOrigin(HTTP_URL, "http://XUXIN.LOCAL:10200/v1.1/api/exhibition"));
        truth(UrlPolicy.sameOrigin("https://example.com/screen", "https://example.com:443/assets/a.png"));
        truth(UrlPolicy.sameOrigin("http://display.lan/screen", "http://display.lan:80/api"));
        falsity(UrlPolicy.sameOrigin(HTTP_URL, "https://xuxin.local:10200/screen"));
        falsity(UrlPolicy.sameOrigin(HTTP_URL, "http://xuxin.local:10201/screen"));
        falsity(UrlPolicy.sameOrigin(HTTP_URL, "http://xuxin.local.evil.com:10200/screen"));
        falsity(UrlPolicy.sameOrigin(HTTP_URL, "http://xuxin.local:10200@evil.local/screen"));
        falsity(UrlPolicy.sameOrigin(HTTP_URL, "file:///etc/passwd"));
        falsity(UrlPolicy.sameOrigin(HTTP_URL, "intent://camera"));
        falsity(UrlPolicy.sameOrigin(HTTP_URL, "data:text/html,hello"));
        truth(UrlPolicy.canUseCamera(UrlPolicy.CAMERA_URL, "https://xuxin.local:10202"));
        falsity(UrlPolicy.canUseCamera(HTTP_URL, "http://xuxin.local:10200"));
        falsity(UrlPolicy.canUseCamera(UrlPolicy.CAMERA_URL, "https://evil.example"));
        falsity(UrlPolicy.canUseCamera(UrlPolicy.CAMERA_URL, "https://xuxin.local:10200"));
        falsity(UrlPolicy.canUseCamera(UrlPolicy.CAMERA_URL, "http://xuxin.local:10202"));
        falsity(UrlPolicy.canUseCamera(UrlPolicy.CAMERA_URL, "file:///camera"));
        truth(UrlPolicy.canLoadSubresource(UrlPolicy.CAMERA_URL, "https://common.rtc.volcvideo.com/get_config"));
        truth(UrlPolicy.canLoadSubresource(UrlPolicy.CAMERA_URL, "https://api.xmaxai.com/open/api/v1/session"));
        falsity(UrlPolicy.canLoadSubresource(UrlPolicy.CAMERA_URL, "https://common.rtc.volcvideo.com.evil.example/data"));
        falsity(UrlPolicy.canLoadSubresource(UrlPolicy.CAMERA_URL, "http://api.xmaxai.com/open/api/v1/session"));
        falsity(UrlPolicy.canLoadSubresource(UrlPolicy.CAMERA_URL, "https://api.xmaxai.com:8443/open/api/v1/session"));
        falsity(UrlPolicy.canLoadSubresource(UrlPolicy.CAMERA_URL, "https://unverified.cos.ap-guangzhou.myqcloud.com/outfit.png"));
        falsity(UrlPolicy.canLoadSubresource(UrlPolicy.CAMERA_URL, "intent://camera"));
        truth(UrlPolicy.canLoadSubresource(UrlPolicy.CAMERA_URL, "https://xmax-us-1256661457.cos.na-ashburn.myqcloud.com/reference.png"));
        truth(UrlPolicy.canLoadSubresource(UrlPolicy.CAMERA_URL, "https://xmax-nj-1256661457.cos.accelerate.myqcloud.com/reference.png"));
        String nativeHttp = "http://xuxin.local:10200/v1.1/api/exhibition/native-identity";
        String nativeHttps = "https://xuxin.local:10202/v1.1/api/exhibition/native-identity";
        String upgraded = UrlPolicy.cameraScreenUrl(HTTP_URL + "?mirror=east");
        truth(UrlPolicy.canReadNativeIdentity(upgraded, upgraded, nativeHttps, "GET", false, "https://xuxin.local:10202"));
        falsity(UrlPolicy.canReadNativeIdentity(upgraded, upgraded, nativeHttp, "GET", false, null));
        falsity(UrlPolicy.canReadNativeIdentity(upgraded, "https://evil.local:10202/v1.1/exhibition/screen", nativeHttps, "GET", false, null));
        truth(UrlPolicy.isNativeIdentityEndpoint(nativeHttp));
        truth(UrlPolicy.isNativeIdentityEndpoint(nativeHttp + "?mirror=default"));
        falsity(UrlPolicy.isNativeIdentityEndpoint("file:///v1.1/api/exhibition/native-identity"));
        truth(UrlPolicy.canReadNativeIdentity(HTTP_URL, HTTP_URL + "?mirror=east", nativeHttp, "GET", false, null));
        truth(UrlPolicy.canReadNativeIdentity(HTTP_URL, HTTP_URL, nativeHttp, "GET", false, "http://xuxin.local:10200"));
        truth(UrlPolicy.canReadNativeIdentity(UrlPolicy.CAMERA_URL, UrlPolicy.CAMERA_URL + "?mirror=east", nativeHttps, "GET", false, "https://xuxin.local:10202"));
        falsity(UrlPolicy.canReadNativeIdentity(HTTP_URL, HTTP_URL, nativeHttp, "GET", true, null));
        falsity(UrlPolicy.canReadNativeIdentity(HTTP_URL, HTTP_URL, nativeHttp, "POST", false, null));
        falsity(UrlPolicy.canReadNativeIdentity(HTTP_URL, HTTP_URL, nativeHttp, "HEAD", false, null));
        falsity(UrlPolicy.canReadNativeIdentity(HTTP_URL, HTTP_URL, nativeHttp + "?", "GET", false, null));
        falsity(UrlPolicy.canReadNativeIdentity(HTTP_URL, HTTP_URL, nativeHttp + "?mirror=east", "GET", false, null));
        falsity(UrlPolicy.canReadNativeIdentity(HTTP_URL, HTTP_URL, nativeHttp + "#identity", "GET", false, null));
        falsity(UrlPolicy.canReadNativeIdentity(HTTP_URL, HTTP_URL, nativeHttp + "/", "GET", false, null));
        falsity(UrlPolicy.canReadNativeIdentity(HTTP_URL, HTTP_URL, nativeHttp.replace("/native-", "/%6eative-"), "GET", false, null));
        falsity(UrlPolicy.canReadNativeIdentity(HTTP_URL, HTTP_URL, nativeHttp.replace("/v1.1", ""), "GET", false, null));
        falsity(UrlPolicy.canReadNativeIdentity(HTTP_URL, HTTP_URL, nativeHttps, "GET", false, null));
        falsity(UrlPolicy.canReadNativeIdentity(UrlPolicy.CAMERA_URL, UrlPolicy.CAMERA_URL, nativeHttp, "GET", false, null));
        falsity(UrlPolicy.canReadNativeIdentity(HTTP_URL, HTTP_URL, nativeHttp.replace(":10200", ":10201"), "GET", false, null));
        falsity(UrlPolicy.canReadNativeIdentity(HTTP_URL, HTTP_URL, nativeHttp.replace("xuxin.local", "evil.local"), "GET", false, null));
        falsity(UrlPolicy.canReadNativeIdentity(HTTP_URL, HTTP_URL, nativeHttp, "GET", false, "https://evil.example"));
        falsity(UrlPolicy.canReadNativeIdentity(HTTP_URL, HTTP_URL, nativeHttp, "GET", false, "null"));
        falsity(UrlPolicy.canReadNativeIdentity(HTTP_URL, HTTP_URL, nativeHttp, "GET", false, ""));
        falsity(UrlPolicy.canReadNativeIdentity(HTTP_URL, null, nativeHttp, "GET", false, null));
        falsity(UrlPolicy.canReadNativeIdentity(HTTP_URL, "https://evil.example/v1.1/exhibition/screen", nativeHttp, "GET", false, null));
        falsity(UrlPolicy.canReadNativeIdentity(HTTP_URL, HTTP_URL.replace("/v1.1", ""), nativeHttp, "GET", false, null));
        falsity(UrlPolicy.canReadNativeIdentity(HTTP_URL.replace("/v1.1", ""), HTTP_URL, nativeHttp, "GET", false, null));
        falsity(UrlPolicy.canReadNativeIdentity(HTTP_URL, HTTP_URL.replace("/screen", "/control"), nativeHttp, "GET", false, null));
        System.out.println("PASS: " + checks + " URL policy assertions");
    }

    private static void equal(String expected, String actual) {
        checks++;
        if (!expected.equals(actual)) throw new AssertionError("Expected " + expected + "; got " + actual);
    }

    private static void truth(boolean actual) { checks++; if (!actual) throw new AssertionError("Expected true"); }
    private static void falsity(boolean actual) { checks++; if (actual) throw new AssertionError("Expected false"); }

    private static void rejected(String value) {
        checks++;
        try { UrlPolicy.normalizeScreenUrl(value); }
        catch (IllegalArgumentException expected) { return; }
        throw new AssertionError("Accepted unsafe/invalid URL: " + value);
    }
}
