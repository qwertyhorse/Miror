package com.google.mediapipe.tasks.core
enum class Delegate { CPU }
class BaseOptions {
 class Builder {
  fun setModelAssetPath(path: String) = apply { check(path == "exhibition-gestures/hand_landmarker.task") }
  fun setDelegate(delegate: Delegate) = this
  fun build() = BaseOptions()
 }
 companion object { fun builder() = Builder() }
}
