package ai.openbuy.exhibition

fun main() {
    fun state(camera: Boolean = false, phase: String = "idle", round: Boolean = false,
              stopping: Boolean = false, live: Boolean = false, ended: Boolean = false,
              realtime: Boolean = true, image: Boolean = false, acting: Boolean = false) =
        NativeMirrorUiState.resolve(realtime, image, camera, round, phase, acting, stopping, live, ended)

    check(state().let { it.primaryText == "等待摄像头…" && it.showPoster && !it.stopIcon && !it.showContinue })
    check(state(camera = true).let { it.primaryText == "开始体验" && !it.showPoster })
    check(state(phase = "generating", round = true).let { it.primaryText == "停止生成" && it.stopIcon && !it.showPoster })
    // CameraReady resets while RTC changes sources; it must not turn a stop action into start/wait.
    check(state(phase = "generating", acting = true).primaryText == "停止生成")
    check(state(phase = "paused").showContinue)
    check(!state(phase = "paused", live = true).showContinue)
    check(state(phase = "paused", stopping = true).let { it.primaryText == "正在停止…" && !it.showContinue })
    check(state(live = true, ended = true).let { it.primaryText == "恢复操作" && it.recoverIcon })
    check(state(realtime = false).let { it.primaryText == "开始体验" && it.showPoster })
    check(state(image = true).let { it.primaryText == "开始体验" && it.showPoster })
    check(state(phase = "showcase", round = true).let { it.stopIcon && !it.showContinue })
    println("Native mirror presentation: 11 cases passed.")
}
