package com.google.mediapipe.framework.image
import android.graphics.Bitmap
class MPImage(val bitmap: Bitmap) { fun close() { bitmap.recycle() } }
class BitmapImageBuilder(private val bitmap: Bitmap) { fun build() = MPImage(bitmap) }
