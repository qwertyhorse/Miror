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
 println("Native metadata assertions: $count passed")
}

