package ai.openbuy.exhibition

import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

fun main() {
    var assertions = 0
    fun verify(condition: Boolean, message: String) {
        check(condition) { message }
        assertions++
    }
    fun address(value: String) = InetAddress.getByAddress(value.split('.').map { it.toInt().toByte() }.toByteArray())
    fun dnsFails(hostname: String): List<InetAddress> = throw UnknownHostException(hostname)
    fun unknownHost(block: () -> Unit) {
        try { block(); error("Expected UnknownHostException") } catch (_: UnknownHostException) { assertions++ }
    }

    for (value in listOf("10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.254", "192.168.0.1")) {
        verify(LanBackendAddress.requirePrivateIpv4(value).hostAddress == value, "Private IPv4 $value")
    }
    for (value in listOf("127.0.0.1", "0.0.0.0", "8.8.8.8", "169.254.1.1", "172.15.1.1", "172.32.0.1",
        "192.169.1.1", "192.168.1.256", "3232235777", "0xc0.0xa8.1.1", "0300.0250.1.1", "192.168.01.1",
        "192.168.1", "192.168.1.1:10200", "http://192.168.1.1", "192.168.1.1/", "192.168.1.1\n", "::1", "", "+10.0.0.1")) {
        try { LanBackendAddress.requirePrivateIpv4(value); error("Accepted unsafe address $value") }
        catch (_: IllegalArgumentException) { assertions++ }
    }
    verify(!LanBackendAddress.isPrivateIpv4(InetAddress.getByAddress(ByteArray(16))), "Reject IPv6 discoveries")

    var discoveries = 0
    var systemCalls = 0
    var clock = 100L
    var nextAddress: InetAddress? = address("192.168.3.7")
    val resolver = LanBackendResolver(
        systemLookup = { systemCalls++; dnsFails(it) },
        discover = { discoveries++; nextAddress },
        nowMillis = { clock },
    )
    verify(resolver.lookup("xuminghong.local").single().hostAddress == "192.168.3.7", "System DNS failure uses NSD")
    verify(discoveries == 1 && systemCalls == 1, "Exactly one first discovery")
    // getHostName returns the explicit hostname without a reverse DNS lookup.
    verify(resolver.lookup("XUMINGHONG.LOCAL").single().hostName == "xuminghong.local", "Retain backend hostname")
    verify(discoveries == 1, "Valid discovery cache reused")
    clock += LanBackendAddress.CACHE_TTL_MILLIS
    nextAddress = address("10.2.4.9")
    verify(resolver.lookup("xuminghong.local").single().hostAddress == "10.2.4.9", "TTL expiry obtains changed IP")
    verify(discoveries == 2, "Expired cache rediscovered")
    clock += LanBackendAddress.CACHE_TTL_MILLIS
    nextAddress = null
    unknownHost { resolver.lookup("xuminghong.local") }
    verify(discoveries == 3, "Failed rediscovery does not reuse stale address")

    for (host in listOf("example.com", "xuminghong.local.evil", "other.local", "192.168.3.7")) {
        unknownHost { resolver.lookup(host) }
    }
    verify(discoveries == 3, "Other hosts never use NSD or cache")

    val systemAddress = address("192.168.8.8")
    val successfulSystem = LanBackendResolver({ listOf(systemAddress) }, { error("Unexpected discovery") })
    verify(successfulSystem.lookup("xuminghong.local").single() == systemAddress, "Working system DNS preferred")
    val manual = LanBackendResolver({ dnsFails(it) }, { error("Unexpected discovery") }, "172.20.3.8")
    verify(manual.lookup("xuminghong.local").single().hostAddress == "172.20.3.8", "Explicit fallback works without discovery")
    unknownHost { manual.lookup("example.com") }
    val manualPreferred = LanBackendResolver({ error("Unexpected system DNS") }, { error("Unexpected discovery") }, "10.1.2.3")
    verify(manualPreferred.lookup("xuminghong.local").single().hostAddress == "10.1.2.3", "Explicit fallback takes priority")
    for (discovered in listOf(address("8.8.8.8"), address("127.0.0.1"), address("169.254.2.3"))) {
        val unsafeDiscovery = LanBackendResolver(::dnsFails, { discovered })
        unknownHost { unsafeDiscovery.lookup("xuminghong.local") }
    }
    val emptySystem = LanBackendResolver({ emptyList() }, { address("192.168.1.9") })
    verify(emptySystem.lookup("xuminghong.local").single().hostAddress == "192.168.1.9", "Empty system answer falls back")

    val discoveredOnce = AtomicInteger()
    val enter = CountDownLatch(1)
    val release = CountDownLatch(1)
    val concurrent = LanBackendResolver(::dnsFails, {
        discoveredOnce.incrementAndGet()
        enter.countDown()
        check(release.await(3, TimeUnit.SECONDS))
        address("192.168.4.5")
    })
    val workers = Executors.newFixedThreadPool(4)
    try {
        val results = (0 until 4).map { workers.submit<List<InetAddress>> { concurrent.lookup("xuminghong.local") } }
        check(enter.await(3, TimeUnit.SECONDS))
        release.countDown()
        results.forEach { verify(it.get(3, TimeUnit.SECONDS).single().hostAddress == "192.168.4.5", "Concurrent result") }
        verify(discoveredOnce.get() == 1, "Concurrent calls share a single discovery")
    } finally {
        release.countDown()
        workers.shutdownNow()
    }
    println("LanBackendDns decisions passed: $assertions assertions; no live DNS or NSD calls.")
}
