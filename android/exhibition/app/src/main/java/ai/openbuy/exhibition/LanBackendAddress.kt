package ai.openbuy.exhibition

import java.net.Inet4Address
import java.net.InetAddress
import java.net.UnknownHostException

/** Numeric parsing only: never ask DNS to interpret an IP entered in settings. */
internal object LanBackendAddress {
    const val DEFAULT_HOSTNAME = "xuxin.local"
    const val CACHE_TTL_MILLIS = 15_000L

    fun isBackendServiceHost(configuredHostname: String, announcedHostname: String) =
        configuredHostname.endsWith(".local", ignoreCase = true) &&
            configuredHostname.equals(announcedHostname.trimEnd('.'), ignoreCase = true)

    fun requirePrivateIpv4(value: String): Inet4Address {
        val parts = value.split('.')
        require(parts.size == 4 && parts.all { it.matches(Regex("0|[1-9][0-9]{0,2}")) }) {
            "请输入局域网 IPv4 地址。"
        }
        val octets = parts.map { it.toInt() }
        require(octets.all { it in 0..255 }) { "请输入局域网 IPv4 地址。" }
        val address = InetAddress.getByAddress(octets.map { it.toByte() }.toByteArray()) as Inet4Address
        require(isPrivateIpv4(address)) { "请输入局域网 IPv4 地址。" }
        return address
    }

    fun isPrivateIpv4(address: InetAddress): Boolean {
        if (address !is Inet4Address) return false
        val bytes = address.address
        val first = bytes[0].toInt() and 255
        val second = bytes[1].toInt() and 255
        return first == 10 || (first == 172 && second in 16..31) || (first == 192 && second == 168)
    }
}

/** Platform-free decision seam. Discovery is serialized and expires with a monotonic clock. */
internal class LanBackendResolver(
    private val systemLookup: (String) -> List<InetAddress>,
    private val discover: () -> InetAddress?,
    fallbackIpv4: String? = null,
    private val nowMillis: () -> Long = { System.nanoTime() / 1_000_000L },
    private val cacheTtlMillis: Long = LanBackendAddress.CACHE_TTL_MILLIS,
    private val backendHostname: String = LanBackendAddress.DEFAULT_HOSTNAME,
) {
    private val manual = fallbackIpv4?.trim()?.takeIf { it.isNotEmpty() }?.let {
        InetAddress.getByAddress(backendHostname, LanBackendAddress.requirePrivateIpv4(it).address)
    }
    private val discoveryLock = Any()
    private var cached: InetAddress? = null
    private var expiresAt = 0L

    @Throws(UnknownHostException::class)
    fun lookup(hostname: String): List<InetAddress> {
        if (!hostname.equals(backendHostname, ignoreCase = true)) return system(hostname)
        manual?.let { return listOf(it) }
        val systemFailure = try {
            return system(hostname)
        } catch (failure: UnknownHostException) {
            failure
        }
        synchronized(discoveryLock) {
            cached?.takeIf { nowMillis() < expiresAt }?.let { return listOf(it) }
            // Do not preserve an expired address if rediscovery fails after a network change.
            cached = null
            val discovered = try {
                discover()
            } catch (failure: Exception) {
                systemFailure.addSuppressed(failure)
                null
            }
            if (discovered != null && LanBackendAddress.isPrivateIpv4(discovered)) {
                // Preserve the original URL hostname without ever triggering reverse DNS.
                val address = InetAddress.getByAddress(backendHostname, discovered.address)
                cached = address
                expiresAt = nowMillis() + cacheTtlMillis
                return listOf(address)
            }
        }
        throw systemFailure
    }

    private fun system(hostname: String): List<InetAddress> = systemLookup(hostname).also {
        if (it.isEmpty()) throw UnknownHostException("No addresses for $hostname")
    }
}
