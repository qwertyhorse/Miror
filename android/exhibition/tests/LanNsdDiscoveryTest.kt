package ai.openbuy.exhibition

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import java.net.InetAddress

/** Real discovery callbacks on an Android-9-shaped NSD boundary. */
fun main() {
    var assertions = 0
    fun verify(value: Boolean, message: String) { check(value) { message }; assertions++ }
    fun service(name: String, hostname: String, lastByte: Int, port: Int = 10101) = NsdServiceInfo(name, "_http._tcp.", port,
        InetAddress.getByAddress(hostname, byteArrayOf(192.toByte(), 168.toByte(), 1, lastByte.toByte())))
    fun fixture(failLegacy: Boolean, numericAddressOnly: Boolean = false) {
        val resolvedNames = mutableListOf<String>()
        var legacyListener: NsdManager.ResolveListener? = null
        var stopped = 0
        val legacy = service("Miror", "xuminghong.local", 3, 10200)
        val target = service("Miror-xuxin", "xuxin.local", 8)
        if (numericAddressOnly) {
            target.host = InetAddress.getByAddress(target.host!!.address)
            target.attributes["hostname"] = "xuxin.local".toByteArray()
        }
        val nsd = object : NsdManager() {
            override fun discoverServices(type: String, protocol: Int, listener: DiscoveryListener) {
                listener.onDiscoveryStarted(type)
                listener.onServiceFound(legacy)
                listener.onServiceFound(service("Miror-other", "other.local", 9))
                // Android reports the right machine while the old Mac is still resolving.
                listener.onServiceFound(target)
                if (failLegacy) legacyListener!!.onResolveFailed(legacy, 3)
                else legacyListener!!.onServiceResolved(legacy)
            }
            override fun resolveService(info: NsdServiceInfo, listener: ResolveListener) {
                resolvedNames += info.serviceName
                if (info.serviceName == "Miror") legacyListener = listener else listener.onServiceResolved(info)
            }
            override fun stopServiceDiscovery(listener: DiscoveryListener) { stopped++; super.stopServiceDiscovery(listener) }
        }
        val wifi = WifiManager()
        val context = Context().apply { services[Context.NSD_SERVICE] = nsd; services[Context.WIFI_SERVICE] = wifi }
        val address = LanBackendDns(context, UrlPolicy.DEFAULT_URL).lookup("xuxin.local").single()
        verify(address.hostAddress == "192.168.1.8", "An old Mac result/failure cannot abort current Ubuntu discovery")
        verify(address.hostName == "xuxin.local", "Resolved address keeps original TLS hostname")
        verify(resolvedNames == listOf("Miror", "Miror-xuxin"), "Pending target resolves next; unrelated unique instances are ignored")
        verify(stopped == 1 && wifi.lock.acquisitions == 1 && wifi.lock.releases == 1 && !wifi.lock.isHeld,
            "Discovery and multicast ownership are released after success")
    }
    fixture(false)
    fixture(true)
    fixture(false, true)
    println("LanNsdDiscoveryTest: $assertions assertions passed")
}
