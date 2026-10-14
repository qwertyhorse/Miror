/*
 * Pure JVM fixtures: no Android device, HTTP request, credential, or camera is used.
 * From android/exhibition, run: sh scripts/test-native.sh
 * The runner extracts the actual NativeRoundMetadata object without rewriting it,
 * then compiles these fixtures using the existing local JVM toolchain.
 */
package ai.openbuy.exhibition
import org.json.JSONObject
fun main() {
 var count=0
 fun verify(value:Boolean) { check(value);count++ }
 fun rejected(block:()->Unit) { try { block() } catch(_:Exception) { count++;return }; error("Unexpected accepted metadata") }
 fun look(mode:String="clothx",kind:String="image")=JSONObject().put("id","commute").put("mode",mode).put("referenceKind",kind).put("image","/assets/exhibition/commute-cutout.png").put("prompt","  测试提示词  ")
 fun state(mode:String="clothx")=JSONObject().put("providerMode","xmax").put("phase","generating").put("experienceMode",mode).put("selectedLookId","commute").put("sessionNumber",2).put("generationNumber",3).put("revision",4)
 val prompts=mapOf("charx" to "视频中角色替换成参考图中角色","clothx" to "视频中人物衣服替换成参考图中衣服","vibex" to "视频风格变为参考图指定的风格","dimx" to "指定角色在场景中互动","mox" to "视频中角色跟随拖拽轨迹运动")
 for((mode,prompt) in prompts) { verify(NativeRoundMetadata.prompt(look(mode))==prompt); NativeRoundMetadata.validateSnapshot(state(mode),look(mode),"default","device-fixture");count++ }
 verify(NativeRoundMetadata.prompt(look("free"))=="测试提示词")
 NativeRoundMetadata.validateSnapshot(state("free"),look("free","none"),"default","device-fixture");count++
 verify(NativeRoundMetadata.referenceImage(look())=="/assets/exhibition/commute-cutout.png")
 verify(NativeRoundMetadata.referenceImage(look().put("referenceImage","/assets/exhibition/reference.png"))=="/assets/exhibition/reference.png")
 verify(NativeRoundMetadata.referenceImage(look("free","none").put("referenceImage","/assets/exhibition/reference.png"))==null)
 NativeRoundMetadata.validateSnapshot(state(),look().put("referenceImage","/assets/exhibition/reference.png"),"default","device-fixture");count++
 rejected { NativeRoundMetadata.validateSnapshot(state(),look().put("referenceImage",""),"default","device-fixture") }
 rejected { NativeRoundMetadata.validateSnapshot(state(),look(kind="none"),"default","device-fixture") }
 rejected { NativeRoundMetadata.validateSnapshot(state().put("generationNumber",3.5),look(),"default","device-fixture") }
 rejected { NativeRoundMetadata.validateSnapshot(state().put("revision","4"),look(),"default","device-fixture") }
 rejected { NativeRoundMetadata.validateSnapshot(state("free"),look(),"default","device-fixture") }
 rejected { NativeRoundMetadata.validateSnapshot(state(),look().put("id","other"),"default","device-fixture") }
 rejected { NativeRoundMetadata.prompt(look("free").put("prompt"," ")) }
 rejected { NativeRoundMetadata.prompt(look("free").put("prompt","a".repeat(1001))) }
 rejected { NativeRoundMetadata.prompt(look("free").put("prompt","a"+0.toChar())) }
 rejected { NativeRoundMetadata.prompt(look("unknown")) }
 val live=JSONObject().put("deviceId","device-fixture").put("lookId","commute").put("generationNumber",3)
 verify(NativeRoundMetadata.ownedLive(state(),live,"device-fixture","commute",2,3))
 verify(!NativeRoundMetadata.ownedLive(state(),live,"other-device","commute",2,3))
 verify(!NativeRoundMetadata.ownedLive(state(),live,"device-fixture","other",2,3))
 verify(!NativeRoundMetadata.ownedLive(state(),live,"device-fixture","commute",1,3))
 verify(!NativeRoundMetadata.ownedLive(state(),live,"device-fixture","commute",2,4))
 verify(NativeRoundMetadata.imageMime(byteArrayOf(137.toByte(),80,78,71,13,10,26,10))=="image/png")
 verify(NativeRoundMetadata.imageMime(byteArrayOf(255.toByte(),216.toByte(),255.toByte()))=="image/jpeg")
 verify(NativeRoundMetadata.imageMime("RIFF1234WEBP".toByteArray())=="image/webp")
 rejected { NativeRoundMetadata.imageMime(byteArrayOf(1,2,3)) }
 verify(NativeRoundMetadata.isRemoteImage("https://fixture.invalid/image.png"))
 for(url in listOf("http://fixture.invalid/a","https://user:pw@fixture.invalid/a","https://fixture.invalid/a#x","not a URL")) verify(!NativeRoundMetadata.isRemoteImage(url))
 val safe=NativeRoundMetadata.safeMessage("异常 tk-fixture uk-fixture sk-fixture https://fixture.invalid/?secret=value")
 verify(!safe.contains("tk-fixture")&&!safe.contains("uk-fixture")&&!safe.contains("sk-fixture")&&!safe.contains("https://"))
 verify(NativeRoundMetadata.integer(JSONObject().put("n",9007199254740992L),"n")==null)
 // Real provider format from the failed Android session, plus equivalent timezones.
 val expiry=1791974706853L
 for(zone in listOf("UTC","Asia/Shanghai","America/New_York")) {
  val previous=java.util.TimeZone.getDefault()
  try {
   java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone(zone))
   for(value in listOf("2026-10-14T10:45:06.853+00:00","2026-10-14T10:45:06.853Z",
       "2026-10-14T18:45:06.853+08:00","2026-10-14T05:15:06.853-05:30"))
    verify(NativeRoundMetadata.expiryMillis(JSONObject().put("expiresAt",value),expiry-1)==expiry)
  } finally { java.util.TimeZone.setDefault(previous) }
 }
 for(fraction in listOf("",".8",".85",".853",".853000",".853000000")) {
  val value="2026-10-14T10:45:06${fraction}+00:00"
  val expected=1791974706000L+when(fraction) { ""->0; ".8"->800; ".85"->850; else->853 }
  verify(NativeRoundMetadata.expiryMillis(JSONObject().put("expiresAt",value),0)==expected)
 }
 fun expiryRejected(value:Any?, message:String) {
  val failure=runCatching { NativeRoundMetadata.expiryMillis(JSONObject().put("expiresAt",value),expiry) }.exceptionOrNull()
  verify(failure?.message==message)
 }
 for(value in listOf(null,JSONObject.NULL,123L,"","bad","2026-10-14T10:45:06.853",
     "2026-02-30T10:45:06Z","2026-13-14T10:45:06Z","2026-10-14T10:45:06+25:00"))
  expiryRejected(value,"体验有效期无效。")
 // Equality is already expired; a past offset timestamp must not become a format error.
 expiryRejected("2026-10-14T10:45:06.853+00:00","本次体验已过期，请重试。")
 expiryRejected("2026-10-14T10:45:06.852+00:00","本次体验已过期，请重试。")
 println("Native metadata assertions: $count passed")
}

