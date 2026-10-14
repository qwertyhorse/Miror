package ai.openbuy.exhibition

import com.sun.net.httpserver.HttpsConfigurator
import com.sun.net.httpserver.HttpsParameters
import com.sun.net.httpserver.HttpsServer
import kotlinx.coroutines.runBlocking
import okhttp3.Dns
import org.json.JSONObject
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
import java.net.UnknownHostException
import java.nio.file.Files
import java.nio.file.Path
import java.security.KeyStore
import java.security.cert.X509Certificate
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext

/** DNS substitutes a socket address, never the TLS identity or HTTP origin. */
object ExhibitionLanTlsTest {
    private const val HOST = "xuminghong.local"
    private const val PASSWORD = "fixturepass"
    private const val SCREEN_PATH = "/v1.1/exhibition/screen"
    private const val CONNECT_PATH = "/v1.1/api/exhibition/terminals/connect"

    @JvmStatic
    fun main(args: Array<String>) = runBlocking {
        val trusted = loadStore("fixture.trustedKeystore")
        val untrusted = loadStore("fixture.untrustedKeystore")
        check(!trusted.certificate.encoded.contentEquals(untrusted.certificate.encoded)) {
            "Trusted and untrusted fixtures must use different certificates."
        }
        check(Path.of(requiredProperty("javax.net.ssl.trustStore")).toRealPath() == trusted.path) {
            "The JVM trust store must be the trusted fixture."
        }

        // Ignore any host-machine proxy configuration: all fixture traffic stays on loopback.
        val previousProxySelector = ProxySelector.getDefault()
        ProxySelector.setDefault(object : ProxySelector() {
            override fun select(uri: URI): List<Proxy> = listOf(Proxy.NO_PROXY)
            override fun connectFailed(uri: URI, address: SocketAddress, error: IOException) = Unit
        })
        var assertions = 0
        fun verify(value: Boolean, message: String) { check(value) { message }; assertions++ }
        suspend fun tlsFailure(api: ExhibitionApi) {
            try {
                api.connectTerminal()
                error("Expected TLS verification to reject the fixture.")
            } catch (error: ExhibitionApiException) {
                verify(error.code == "TLS_ERROR", "Expected TLS_ERROR, received ${error.code}.")
            }
        }
        try {
            TlsFixture(trusted.store).use { good ->
                val dns = LoopbackDns(HOST)
                val origin = "https://$HOST:${good.port}"
                val response = api(origin, dns).connectTerminal()
                verify(dns.lookups.get() > 0, "The custom DNS must supply the loopback address.")
                verify(response.getString("host") == "$HOST:${good.port}", "Host must retain the configured domain and port.")
                verify(response.getString("origin") == origin, "Origin must retain the HTTPS domain and port.")
                verify(response.getString("path") == CONNECT_PATH, "The real native connection endpoint must be used.")
                verify(response.getString("method") == "POST", "The fixture must exercise a business POST.")
                verify(good.requests.get() == 1, "The trusted fixture must receive exactly one request.")

                val wrongHost = "wrong-openbuy.local"
                val wrongDns = LoopbackDns(wrongHost)
                tlsFailure(api("https://$wrongHost:${good.port}", wrongDns))
                verify(wrongDns.lookups.get() > 0, "The wrong domain must resolve to the same local server.")
                verify(good.requests.get() == 1, "A mismatched certificate hostname must prevent the business request.")
            }
            TlsFixture(untrusted.store).use { bad ->
                val dns = LoopbackDns(HOST)
                tlsFailure(api("https://$HOST:${bad.port}", dns))
                verify(dns.lookups.get() > 0, "The untrusted fixture must resolve through the custom DNS.")
                verify(bad.requests.get() == 0, "An untrusted same-name certificate must prevent the business request.")
            }
            println("Exhibition LAN TLS passed: $assertions assertions; hostname and trust checks preserved; loopback fixtures only.")
        } finally {
            ProxySelector.setDefault(previousProxySelector)
        }
    }

    private fun api(origin: String, dns: Dns) = ExhibitionApi(
        "$origin$SCREEN_PATH",
        "terminal-12345678-1234-1234-1234-123456789abc",
        "fixture-device-credential-0123456789",
        "TLS 测试智能镜",
        dns,
    )

    private fun requiredProperty(name: String) = requireNotNull(System.getProperty(name)?.takeIf { it.isNotBlank() }) {
        "Missing JVM property: $name"
    }

    private data class FixtureStore(val path: Path, val store: KeyStore, val certificate: X509Certificate)

    private fun loadStore(property: String): FixtureStore {
        val path = Path.of(requiredProperty(property)).toRealPath()
        val store = KeyStore.getInstance("JKS").apply {
            Files.newInputStream(path).use { load(it, PASSWORD.toCharArray()) }
        }
        val aliases = store.aliases().toList().filter { store.isKeyEntry(it) }
        check(aliases.size == 1) { "Each fixture JKS must contain exactly one server key." }
        val certificate = store.getCertificate(aliases.single()) as X509Certificate
        check(certificate.subjectAlternativeNames.orEmpty().any {
            it.size >= 2 && it[0] == 2 && it[1] == HOST
        }) { "Each fixture certificate must have the DNS SAN $HOST." }
        return FixtureStore(path, store, certificate)
    }

    private class LoopbackDns(private val expectedHost: String) : Dns {
        val lookups = AtomicInteger()
        override fun lookup(hostname: String): List<InetAddress> {
            if (hostname != expectedHost) throw UnknownHostException("Unexpected fixture hostname.")
            lookups.incrementAndGet()
            return listOf(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))
        }
    }

    private class TlsFixture(store: KeyStore) : AutoCloseable {
        val requests = AtomicInteger()
        private val executor = Executors.newCachedThreadPool()
        private val server = HttpsServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val port: Int get() = server.address.port

        init {
            val managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
                init(store, PASSWORD.toCharArray())
            }
            val context = SSLContext.getInstance("TLS").apply { init(managers.keyManagers, null, null) }
            server.httpsConfigurator = object : HttpsConfigurator(context) {
                override fun configure(parameters: HttpsParameters) {
                    parameters.setSSLParameters(context.defaultSSLParameters.apply { needClientAuth = false })
                }
            }
            server.executor = executor
            server.createContext("/") { exchange ->
                requests.incrementAndGet()
                try {
                    exchange.requestBody.use { it.readBytes() }
                    val response = JSONObject()
                        .put("host", exchange.requestHeaders.getFirst("Host"))
                        .put("origin", exchange.requestHeaders.getFirst("Origin"))
                        .put("path", exchange.requestURI.path)
                        .put("method", exchange.requestMethod)
                        .toString().toByteArray(Charsets.UTF_8)
                    exchange.responseHeaders.set("Content-Type", "application/json")
                    exchange.sendResponseHeaders(200, response.size.toLong())
                    exchange.responseBody.use { it.write(response) }
                } finally {
                    exchange.close()
                }
            }
            server.start()
        }

        override fun close() {
            server.stop(0)
            executor.shutdownNow()
        }
    }
}
