package ai.openbuy.exhibition

/** Presentation only: camera/session ownership and command eligibility stay in the Activity. */
internal data class NativeMirrorUiState(
    val primaryText: String,
    val stopIcon: Boolean,
    val recoverIcon: Boolean,
    val showPoster: Boolean,
    val showContinue: Boolean,
) {
    val showFooterStop: Boolean get() = stopIcon && !recoverIcon

    companion object {
        fun resolve(
            realtime: Boolean,
            imageInput: Boolean,
            cameraReady: Boolean,
            hasRound: Boolean,
            phase: String,
            actionBusy: Boolean,
            stopBusy: Boolean,
            hasLive: Boolean,
            localEnded: Boolean,
        ): NativeMirrorUiState {
            val paused = phase == "paused"
            val active = actionBusy || hasRound || hasLive || phase in listOf("generating", "showcase", "positioning")
            val cleaning = paused && (hasRound || hasLive || stopBusy)
            val waitingForCamera = realtime && !imageInput && !cameraReady && !active && !stopBusy
            return NativeMirrorUiState(
                primaryText = when {
                    cleaning -> "正在清理…"
                    stopBusy -> "正在停止…"
                    localEnded -> "恢复操作"
                    active && !paused -> "停止生成"
                    waitingForCamera -> "等待摄像头…"
                    else -> "开始体验"
                },
                stopIcon = !paused && (stopBusy || active),
                recoverIcon = localEnded,
                // A hidden RTC render target cannot report its first preview frame: the Activity
                // keeps it VISIBLE under this poster until the actual camera-ready callback.
                showPoster = !realtime || imageInput || (!cameraReady && !hasRound && !hasLive),
                showContinue = false,
            )
        }
    }
}
