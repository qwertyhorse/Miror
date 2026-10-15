package ai.openbuy.exhibition

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.ext.SdkExtensions
import okhttp3.Dns
import java.net.InetAddress
import java.net.URI
import java.net.UnknownHostException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Resolve only the configured backend; retain the URL, HTTP Host and TLS server name. */
internal class LanBackendDns(context: Context, screenUrl: String, fallbackIpv4: String? = null) : Dns {
    private val application = context.applicationContext
    private val hostname = URI(UrlPolicy.cameraScreenUrl(screenUrl)).host
    private val resolver = LanBackendResolver(
        systemLookup = { Dns.SYSTEM.lookup(it) },
        discover = { if (hostname.endsWith(".local", ignoreCase = true)) LanNsdDiscovery(application, hostname).discover() else null },
        fallbackIpv4 = fallbackIpv4,
        backendHostname = hostname,
    )

    @Throws(UnknownHostException::class)
    override fun lookup(hostname: String): List<InetAddress> = resolver.lookup(hostname)
}

/** A legacy NSD resolve cannot be cancelled on Android 9; retain its gate until its callback. */
private object LanNsdResolutionGate {
    val active = AtomicReference<NsdManager.ResolveListener?>()
}

@Suppress("DEPRECATION")
private class LanNsdDiscovery(private val application: Context, private val hostname: String) {
    private val nsd = application.getSystemService(Context.NSD_SERVICE) as? NsdManager
    private val monitor = Any()
    private val completion = CountDownLatch(1)
    private var closed = false
    private var discoveryRegistered = false
    private var stopRequested = false
    private var result: InetAddress? = null
    private var resolution: NsdManager.ResolveListener? = null
    private val candidates = linkedMapOf<String, NsdServiceInfo>()
    private val seen = mutableSetOf<String>()

    private val discovery = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(serviceType: String) {
            if (synchronized(monitor) { closed }) stopDiscovery()
        }

        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
            synchronized(monitor) { discoveryRegistered = false }
            finish(null)
        }

        override fun onDiscoveryStopped(serviceType: String) {
            synchronized(monitor) { discoveryRegistered = false }
            finish(null)
        }

        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
            // The legacy framework removes the listener for this callback too.
            synchronized(monitor) { discoveryRegistered = false }
            finish(null)
        }

        override fun onServiceLost(serviceInfo: NsdServiceInfo) {
            synchronized(monitor) { candidates.remove(serviceInfo.serviceName) }
        }

        override fun onServiceFound(serviceInfo: NsdServiceInfo) {
            if (!isBackendService(serviceInfo)) return
            synchronized(monitor) {
                if (closed || !seen.add(serviceInfo.serviceName)) return
                candidates[serviceInfo.serviceName] = serviceInfo
            }
            resolveNext()
        }
    }

    private fun resolveNext() {
        synchronized(monitor) {
            if (closed || resolution != null) return
            val candidate = candidates.values.firstOrNull { it.serviceName != "Miror" }
                ?: candidates.values.firstOrNull() ?: return
            val listener = object : NsdManager.ResolveListener {
                override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) = resolved(this, null)

                override fun onServiceResolved(info: NsdServiceInfo) {
                    val addresses = if (supportsResolutionStop()) info.hostAddresses else listOfNotNull(info.host)
                    val advertisedHostname = info.attributes["hostname"]?.toString(Charsets.UTF_8).orEmpty()
                    // Read the announced name without performing a blocking reverse lookup.
                    // Android 9 often exposes only the address, so our publisher also includes
                    // the hostname as TXT. HTTPS still verifies the configured URL's TLS name.
                    val address = addresses.firstOrNull { address ->
                        LanBackendAddress.isPrivateIpv4(address) &&
                            (LanBackendAddress.isBackendServiceHost(hostname, address.toString().substringBefore('/')) ||
                                LanBackendAddress.isBackendServiceHost(hostname, advertisedHostname))
                    }
                    resolved(this, address?.takeIf { isBackendService(info) && info.port in BACKEND_PORTS })
                }

                override fun onResolutionStopped(info: NsdServiceInfo) = resolved(this, null)
            }
            if (!LanNsdResolutionGate.active.compareAndSet(null, listener)) return
            candidates.remove(candidate.serviceName)
            resolution = listener
            try { nsd?.resolveService(candidate, listener) }
            catch (_: RuntimeException) { resolved(listener, null) }
        }
    }

    private fun resolved(listener: NsdManager.ResolveListener, address: InetAddress?) {
        LanNsdResolutionGate.active.compareAndSet(listener, null)
        synchronized(monitor) {
            if (resolution !== listener) return
            resolution = null
            if (closed) return
        }
        // Another computer's legacy "Miror" service must not end discovery of this backend.
        if (address != null) finish(address) else resolveNext()
    }

    fun discover(): InetAddress? {
        if (nsd == null) return null
        var multicast: WifiManager.MulticastLock? = null
        try {
            // Before T extension 7 NSD needs multicast reception even while foregrounded.
            if (!supportsResolutionStop()) {
                val wifi = application.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                multicast = wifi?.createMulticastLock("openbuy-lan-discovery")?.apply {
                    setReferenceCounted(false)
                    acquire()
                }
            }
            synchronized(monitor) { discoveryRegistered = true }
            try {
                nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discovery)
            } catch (_: RuntimeException) {
                synchronized(monitor) { discoveryRegistered = false }
                finish(null)
            }
            completion.await(DISCOVERY_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        } catch (_: RuntimeException) {
            // Missing or unavailable Wi-Fi/NSD support must remain a bounded DNS failure.
        } finally {
            finish(null)
            if (multicast?.isHeld == true) multicast.release()
        }
        return synchronized(monitor) { result }
    }

    private fun finish(address: InetAddress?) {
        val pending: NsdManager.ResolveListener?
        synchronized(monitor) {
            if (closed) return
            closed = true
            result = address
            pending = resolution?.takeIf { LanNsdResolutionGate.active.get() === it }
        }
        stopDiscovery()
        if (pending != null && supportsResolutionStop()) {
            try {
                nsd?.stopServiceResolution(pending)
            } catch (_: IllegalArgumentException) {
                // Listener was already removed; no legacy resolution is still outstanding.
                LanNsdResolutionGate.active.compareAndSet(pending, null)
            } catch (_: RuntimeException) {
                // Keep the gate until the system's eventual callback rather than overlap resolves.
            }
        }
        completion.countDown()
    }

    private fun stopDiscovery() {
        val shouldStop = synchronized(monitor) {
            if (!discoveryRegistered || stopRequested) false else {
                stopRequested = true
                true
            }
        }
        if (shouldStop) {
            try {
                nsd?.stopServiceDiscovery(discovery)
            } catch (_: RuntimeException) {
                synchronized(monitor) { discoveryRegistered = false }
            }
        }
    }

    private fun isBackendService(info: NsdServiceInfo): Boolean {
        val type = info.serviceType.trimEnd('.')
        return LanBackendAddress.isBackendServiceInstance(hostname, info.serviceName) &&
            (type.equals(SERVICE_TYPE, ignoreCase = true) || type.equals("$SERVICE_TYPE.local", ignoreCase = true))
    }

    private fun supportsResolutionStop(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ||
        (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            SdkExtensions.getExtensionVersion(Build.VERSION_CODES.TIRAMISU) >= 7)

    private companion object {
        const val SERVICE_TYPE = "_http._tcp"
        val BACKEND_PORTS = setOf(10200, 10101)
        const val DISCOVERY_TIMEOUT_MILLIS = 3_000L
    }
}
