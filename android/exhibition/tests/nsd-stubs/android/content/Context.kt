package android.content
open class Context {
 val services=mutableMapOf<String,Any>()
 val applicationContext: Context get() = this
 fun getSystemService(name:String):Any? = services[name]
 companion object { const val NSD_SERVICE="nsd";const val WIFI_SERVICE="wifi" }
}
