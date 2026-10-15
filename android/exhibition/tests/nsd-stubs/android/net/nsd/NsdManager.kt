package android.net.nsd
import java.net.InetAddress
class NsdServiceInfo(var serviceName:String,var serviceType:String,var port:Int,var host:InetAddress?) {
 val hostAddresses:List<InetAddress> get()=listOfNotNull(host)
 val attributes=mutableMapOf<String,ByteArray>()
}
open class NsdManager {
 interface DiscoveryListener {
  fun onDiscoveryStarted(serviceType:String)
  fun onStartDiscoveryFailed(serviceType:String,errorCode:Int)
  fun onDiscoveryStopped(serviceType:String)
  fun onStopDiscoveryFailed(serviceType:String,errorCode:Int)
  fun onServiceLost(serviceInfo:NsdServiceInfo)
  fun onServiceFound(serviceInfo:NsdServiceInfo)
 }
 interface ResolveListener {
  fun onResolveFailed(info:NsdServiceInfo,errorCode:Int)
  fun onServiceResolved(info:NsdServiceInfo)
  fun onResolutionStopped(info:NsdServiceInfo)
 }
 open fun discoverServices(type:String,protocol:Int,listener:DiscoveryListener) {}
 open fun stopServiceDiscovery(listener:DiscoveryListener) {listener.onDiscoveryStopped("_http._tcp")}
 open fun resolveService(info:NsdServiceInfo,listener:ResolveListener) {}
 open fun stopServiceResolution(listener:ResolveListener) {}
 companion object { const val PROTOCOL_DNS_SD=1 }
}
