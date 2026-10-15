package okhttp3
import java.net.InetAddress
import java.net.UnknownHostException
interface Dns {
 fun lookup(hostname:String):List<InetAddress>
 companion object {val SYSTEM=object:Dns {override fun lookup(hostname:String):List<InetAddress> = throw UnknownHostException(hostname)}}
}
