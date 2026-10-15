package android.net.wifi
class WifiManager {
 val lock=MulticastLock()
 fun createMulticastLock(tag:String)=lock
 class MulticastLock {
  var isHeld=false;var acquisitions=0;var releases=0
  fun setReferenceCounted(value:Boolean) {}
  fun acquire(){isHeld=true;acquisitions++}
  fun release(){isHeld=false;releases++}
 }
}
