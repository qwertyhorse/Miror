package com.google.mediapipe.tasks.vision.handlandmarker
import android.content.Context
import com.google.mediapipe.framework.image.MPImage
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
object InferenceFixture {
 @Volatile var entered: CountDownLatch? = null
 @Volatile var resume: CountDownLatch? = null
 @Volatile var fail = false
 @Volatile var failLinkage = false
 val calls = AtomicInteger(); val closes = AtomicInteger(); val creates = AtomicInteger()
 val threads = java.util.Collections.synchronizedSet(mutableSetOf<Long>())
 @Volatile var lastOptions: HandLandmarker.HandLandmarkerOptions? = null
 fun thread() { threads.add(Thread.currentThread().id) }
}
class Point(private val value: Float) { fun x()=value; fun y()=value; fun z()=0f }
class Category(private val value: String) { fun categoryName()=value }
class Result {
 fun landmarks() = listOf(List(21) { Point(.2f) }, List(21) { Point(.7f) })
 fun handedness() = listOf(listOf(Category("Left")), listOf(Category("Right")))
}
class HandLandmarker {
 fun detectForVideo(image: MPImage, timestamp: Long): Result {
  InferenceFixture.thread(); InferenceFixture.calls.incrementAndGet()
  InferenceFixture.entered?.countDown()
  check(InferenceFixture.resume?.await(5, TimeUnit.SECONDS) != false)
  if (InferenceFixture.failLinkage) throw UnsatisfiedLinkError("fixture native library unavailable")
  check(!InferenceFixture.fail) { "fixture failure" }
  check(image.bitmap.recycleCount.get() == 0) { "Bitmap was recycled during inference" }
  return Result()
 }
 fun close() { InferenceFixture.thread(); InferenceFixture.closes.incrementAndGet() }
 class HandLandmarkerOptions(val detection: Float, val presence: Float, val tracking: Float) {
  class Builder {
   private var detection=0f; private var presence=0f; private var tracking=0f
   fun setBaseOptions(options: BaseOptions) = this
   fun setRunningMode(mode: RunningMode) = this
   fun setNumHands(value: Int) = apply { check(value==2) }
   fun setMinHandDetectionConfidence(value: Float) = apply { detection=value }
   fun setMinHandPresenceConfidence(value: Float) = apply { presence=value }
   fun setMinTrackingConfidence(value: Float) = apply { tracking=value }
   fun build()=HandLandmarkerOptions(detection,presence,tracking)
  }
  companion object { fun builder()=Builder() }
 }
 companion object {
  fun createFromOptions(context: Context, options: HandLandmarkerOptions): HandLandmarker {
   InferenceFixture.thread(); InferenceFixture.creates.incrementAndGet(); InferenceFixture.lastOptions=options
   return HandLandmarker()
  }
 }
}
