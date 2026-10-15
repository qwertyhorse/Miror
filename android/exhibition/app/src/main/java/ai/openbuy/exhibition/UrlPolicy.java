package ai.openbuy.exhibition;

import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;
import java.io.UnsupportedEncodingException;
import java.util.Locale;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/** Pure Java URL validation, also exercised by the SDK-independent contract test. */
public final class UrlPolicy {
    public static final String DEFAULT_URL = "https://xuxin.local:10202/v1.1/exhibition/screen";
    public static final String CAMERA_URL = DEFAULT_URL;
    private static final String SCREEN_PATH = "/v1.1/exhibition/screen";
    private static final String NATIVE_IDENTITY_PATH = "/v1.1/api/exhibition/native-identity";
    // Exact origins verified in installed @xmaxai/sdk-global 1.1.13 and @volcengine/rtc 4.69.2.
    // These are subresources only. Dynamic COS buckets require separate verification.
    private static final Set<String> SDK_HOSTS = new HashSet<>(Arrays.asList(
        "api.decart.ai", "platform.decart.ai", "lk.decart.ai",
        "api.xmaxai.com", "api.xmax.ai", "log.xmaxai.com", "api.xmax.cloud",
        "access.rtc.volcvideo.com", "access2-hl.rtc.volcvideo.com", "common.rtc.volcvideo.com",
        "rtcg-access.volcvideos.com", "rtcg.volcvideos.com",
        "web-log-report.rtc.volcvideo.com", "web-log-report.volcvideos.com",
        // Verified hostnames from existing successful upload references; no tokens/keys are embedded.
        "xmax-nj-1256661457.cos.accelerate.myqcloud.com", "xmax-us-1256661457.cos.na-ashburn.myqcloud.com"
    ));

    private UrlPolicy() {}

    /** Migrate only the former bundled endpoint; retain explicit custom backends. */
    public static String migrateDefaultScreenUrl(String input) {
        if (input == null) return DEFAULT_URL;
        String value = cameraScreenUrl(input);
        if (!isLegacyDefaultScreenUrl(input)) return value;
        URI uri = parseHttpUrl(value);
        return DEFAULT_URL + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery())
            + (uri.getRawFragment() == null ? "" : "#" + uri.getRawFragment());
    }

    private static boolean isLegacyDefaultScreenUrl(String input) {
        if (input == null) return true;
        try {
            URI uri = parseHttpUrl(normalizeScreenUrl(input));
            return host(uri).equals("xuminghong.local") && isMirrorPath(uri)
                && (uri.getScheme().equalsIgnoreCase("https") && uri.getPort() == 10202
                    || uri.getScheme().equalsIgnoreCase("http") && uri.getPort() == 10200);
        } catch (IllegalArgumentException ignored) { return false; }
    }

    /** Clear the former automatic IP only when its bundled backend is migrating. */
    public static boolean shouldClearLegacyFallback(String savedUrl, String fallbackIp, boolean wasPrefilled) {
        return wasPrefilled && "192.168.63.54".equals(fallbackIp) && isLegacyDefaultScreenUrl(savedUrl);
    }

    public static String normalizeScreenUrl(String input) {
        if (input == null || input.trim().isEmpty()) {
            throw new IllegalArgumentException("请输入展台网址");
        }
        String value = input.trim();
        if (!value.contains("://")) value = "http://" + value;
        URI uri = parseHttpUrl(value);
        String host = host(uri);
        if (uri.getScheme().equalsIgnoreCase("http") && !isLocalHost(host)) {
            throw new IllegalArgumentException("HTTP 仅用于局域网域名或私有 IP；公网地址请使用 HTTPS");
        }
        String path = uri.getRawPath();
        if (path == null || path.isEmpty() || path.equals("/")) path = SCREEN_PATH;
        String authority = host.contains(":") ? "[" + host + "]" : host;
        if (uri.getPort() != -1) authority += ":" + uri.getPort();
        String query = uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery();
        String fragment = uri.getRawFragment() == null ? "" : "#" + uri.getRawFragment();
        return uri.getScheme().toLowerCase(Locale.ROOT) + "://" + authority + path + query + fragment;
    }

    /** Upgrade the legacy local mirror before loading; installation identity stays native. */
    public static String cameraScreenUrl(String input) {
        String value = normalizeScreenUrl(input);
        URI uri = parseHttpUrl(value);
        if (!uri.getScheme().equalsIgnoreCase("http") || !isBackendHttpPort(uri.getPort()) || !isMirrorPath(uri)) return value;
        String hostname = host(uri);
        String authority = hostname.contains(":") ? "[" + hostname + "]" : hostname;
        String query = uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery();
        String fragment = uri.getRawFragment() == null ? "" : "#" + uri.getRawFragment();
        return "https://" + authority + ":10202" + SCREEN_PATH + query + fragment;
    }

    /** Only the same local host's exact legacy/camera mirror endpoints can switch origins. */
    public static String trustedCameraNavigation(String configuredUrl, String target) {
        try {
            URI configured = parseHttpUrl(configuredUrl);
            URI requested = parseHttpUrl(target);
            if (!host(configured).equals(host(requested)) || !isLocalHost(host(configured))
                    || !isMirrorEntry(configured) || !isMirrorEntry(requested)) return null;
            return cameraScreenUrl(target);
        } catch (IllegalArgumentException error) { return null; }
    }

    private static boolean isMirrorPath(URI uri) {
        return SCREEN_PATH.equals(uri.getRawPath()) || (SCREEN_PATH + "/").equals(uri.getRawPath());
    }

    private static boolean isMirrorEntry(URI uri) {
        return isMirrorPath(uri) && (uri.getScheme().equalsIgnoreCase("http") && isBackendHttpPort(uri.getPort())
            || uri.getScheme().equalsIgnoreCase("https") && uri.getPort() == 10202);
    }

    private static boolean isBackendHttpPort(int port) { return port == 10200 || port == 10101; }

    /** Changing HTTP/HTTPS or restoring the host must not reassign the physical mirror. */
    public static String preserveMirror(String targetUrl, String currentUrl) {
        String target = normalizeScreenUrl(targetUrl);
        URI source = parseHttpUrl(normalizeScreenUrl(currentUrl));
        String mirror = null;
        if (source.getRawQuery() != null) {
            for (String part : source.getRawQuery().split("&", -1)) {
                if (isMirrorParameter(part)) { mirror = part; break; }
            }
        }
        if (mirror == null) return target;
        int fragmentStart = target.indexOf('#');
        String fragment = fragmentStart < 0 ? "" : target.substring(fragmentStart);
        String beforeFragment = fragmentStart < 0 ? target : target.substring(0, fragmentStart);
        int queryStart = beforeFragment.indexOf('?');
        String path = queryStart < 0 ? beforeFragment : beforeFragment.substring(0, queryStart);
        StringBuilder query = new StringBuilder();
        if (queryStart >= 0) {
            for (String part : beforeFragment.substring(queryStart + 1).split("&", -1)) {
                if (!part.isEmpty() && !isMirrorParameter(part)) {
                    if (query.length() > 0) query.append('&');
                    query.append(part);
                }
            }
        }
        if (query.length() > 0) query.append('&');
        return path + "?" + query.append(mirror) + fragment;
    }

    private static boolean isMirrorParameter(String part) {
        int equals = part.indexOf('=');
        String key = equals < 0 ? part : part.substring(0, equals);
        try { return URLDecoder.decode(key, "UTF-8").equals("mirror"); }
        catch (UnsupportedEncodingException impossible) { throw new IllegalStateException(impossible); }
    }

    public static boolean sameOrigin(String configuredUrl, String candidate) {
        try {
            URI configured = parseHttpUrl(configuredUrl);
            URI requested = parseHttpUrl(candidate);
            return configured.getScheme().equalsIgnoreCase(requested.getScheme())
                && host(configured).equals(host(requested))
                && effectivePort(configured) == effectivePort(requested);
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    public static boolean canUseCamera(String configuredUrl, String requestingOrigin) {
        try {
            return parseHttpUrl(configuredUrl).getScheme().equalsIgnoreCase("https")
                && sameOrigin(configuredUrl, requestingOrigin);
        } catch (IllegalArgumentException error) { return false; }
    }

    public static boolean isNativeIdentityEndpoint(String candidate) {
        try { return NATIVE_IDENTITY_PATH.equals(parseHttpUrl(candidate).getRawPath()); }
        catch (IllegalArgumentException error) { return false; }
    }

    /** The installation secret is available only to a fetch from the configured V1.1 screen. */
    public static boolean canReadNativeIdentity(String configuredUrl, String pageUrl, String candidate,
            String method, boolean mainFrame, String requestingOrigin) {
        if (mainFrame || !"GET".equals(method) || !sameOrigin(configuredUrl, candidate)
                || !sameOrigin(configuredUrl, pageUrl)
                || (requestingOrigin != null && !sameOrigin(configuredUrl, requestingOrigin))) return false;
        try {
            URI configured = parseHttpUrl(configuredUrl);
            URI page = parseHttpUrl(pageUrl);
            URI requested = parseHttpUrl(candidate);
            return SCREEN_PATH.equals(configured.getRawPath()) && SCREEN_PATH.equals(page.getRawPath())
                && NATIVE_IDENTITY_PATH.equals(requested.getRawPath())
                && requested.getRawQuery() == null && requested.getRawFragment() == null;
        } catch (IllegalArgumentException error) { return false; }
    }

    public static boolean canLoadSubresource(String configuredUrl, String candidate) {
        if (sameOrigin(configuredUrl, candidate)) return true;
        try {
            URI uri = parseHttpUrl(candidate);
            return uri.getScheme().equalsIgnoreCase("https") && effectivePort(uri) == 443 && (SDK_HOSTS.contains(host(uri)) || host(uri).matches("[a-z0-9-]+\\.lkc\\.decart\\.ai"));
        } catch (IllegalArgumentException error) { return false; }
    }

    private static URI parseHttpUrl(String input) {
        if (input == null || input.contains("\\") || input.matches(".*[\\p{Cntrl}\\s].*")) {
            throw new IllegalArgumentException("网址不能包含空白、控制字符或反斜杠");
        }
        try {
            URI uri = new URI(input);
            String scheme = uri.getScheme();
            if (scheme == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) {
                throw new IllegalArgumentException("仅支持 HTTP 或 HTTPS 网址");
            }
            if (uri.getHost() == null || uri.getRawUserInfo() != null || uri.getPort() == 0
                    || uri.getPort() > 65535 || uri.getPort() < -1
                    || uri.getRawAuthority().endsWith(":")) {
                throw new IllegalArgumentException("请填写有效域名和端口，网址不能包含账号密码");
            }
            return uri;
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("网址格式不正确");
        }
    }

    private static String host(URI uri) {
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
        return host;
    }

    private static int effectivePort(URI uri) {
        return uri.getPort() != -1 ? uri.getPort() : uri.getScheme().equalsIgnoreCase("https") ? 443 : 80;
    }

    private static boolean isLocalHost(String host) {
        if (host.equals("::1") || host.matches("(?i)(fc|fd)[0-9a-f]{2}:.*")
                || host.matches("(?i)fe[89ab][0-9a-f]:.*")) return true;
        if (host.matches("[0-9.]+")) {
            String[] parts = host.split("\\.", -1);
            if (parts.length != 4) return false;
            int[] octets = new int[4];
            try {
                for (int i = 0; i < 4; i++) {
                    if (parts[i].isEmpty() || parts[i].length() > 3
                            || (parts[i].length() > 1 && parts[i].startsWith("0"))) return false;
                    octets[i] = Integer.parseInt(parts[i]);
                    if (octets[i] > 255) return false;
                }
            } catch (NumberFormatException error) { return false; }
            return octets[0] == 10 || octets[0] == 127
                || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
                || (octets[0] == 192 && octets[1] == 168)
                || (octets[0] == 169 && octets[1] == 254);
        }
        return host.matches("[a-z][a-z0-9-]*") || host.endsWith(".local") || host.endsWith(".lan");
    }
}
