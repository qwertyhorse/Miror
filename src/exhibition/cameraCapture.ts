class CameraTrackUnavailableError extends Error {
  constructor() { super('摄像头没有返回有效画面，请重新开启。'); }
}

function release(stream: MediaStream) {
  stream.getTracks().forEach(track => track.stop());
}

function waitForRelease(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** Android camera drivers can return an ended stream while the previous page releases capture. */
export async function acquireExhibitionCamera(constraints: MediaStreamConstraints, signal: AbortSignal): Promise<MediaStream | null> {
  const retryDelays = [500, 1200];
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) return null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (signal.aborted) { release(stream); return null; }
      if (stream.getVideoTracks().some(track => track.readyState === 'live')) return stream;
      release(stream);
      throw new CameraTrackUnavailableError();
    } catch (cause) {
      if (signal.aborted) return null;
      const retryable = cause instanceof CameraTrackUnavailableError
        || (cause instanceof Error && ['NotReadableError', 'AbortError'].includes(cause.name));
      if (!retryable || attempt >= retryDelays.length) throw cause;
      // Reuse the exact tested device and profile on every attempt.
      await waitForRelease(retryDelays[attempt], signal);
    }
  }
}

export function cameraTrackDeviceId(track: MediaStreamTrack): string {
  try { return track.getSettings?.().deviceId ?? ''; }
  catch { return ''; }
}
