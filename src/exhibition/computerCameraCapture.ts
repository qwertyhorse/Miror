import { acquireExhibitionCamera, cameraTrackDeviceId } from './cameraCapture';

export interface OwnedComputerCamera {
  stream: MediaStream;
  /** Stop this capture and make its camera available to another mirror. */
  release(): void;
}

const cameraLockPrefix = 'exhibition-computer-camera:';

class ComputerCameraBusyError extends Error {
  constructor() {
    super('这个摄像头正在供另一台智能镜使用，请选择其他摄像头。');
    this.name = 'ComputerCameraBusyError';
  }
}

type CameraLease = { release(): void };

/** The callback stays pending for the capture's lifetime, including across browser tabs. */
function claimCamera(deviceId: string): Promise<CameraLease | null> {
  if (!navigator.locks?.request) return Promise.resolve({ release() {} });
  return new Promise((resolve, reject) => {
    const request = navigator.locks.request(`${cameraLockPrefix}${deviceId}`, { mode: 'exclusive', ifAvailable: true }, lock => {
      if (!lock) { resolve(null); return; }
      return new Promise<void>(release => { resolve({ release }); });
    });
    void request.catch(reject);
  });
}

async function claimReleasedCamera(deviceId: string, signal: AbortSignal, waitForRelease: boolean): Promise<CameraLease | null> {
  // A replaced tab learns that its host was revoked on its next poll, then
  // releases capture. Wait briefly for that handoff without stealing its lock.
  for (let attempt = 0; !signal.aborted; attempt++) {
    const lease = await claimCamera(deviceId);
    if (lease || !waitForRelease || attempt >= 20) return lease;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, 250);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  }
  return null;
}

function stopTracks(stream: MediaStream) {
  stream.getTracks().forEach(track => track.stop());
}

function ownCamera(stream: MediaStream, lease: CameraLease, signal: AbortSignal): OwnedComputerCamera | null {
  let released = false;
  const videoTracks = stream.getVideoTracks();
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener('abort', release);
    videoTracks.forEach(track => track.removeEventListener?.('ended', release));
    stopTracks(stream);
    lease.release();
  };
  signal.addEventListener('abort', release, { once: true });
  videoTracks.forEach(track => track.addEventListener?.('ended', release, { once: true }));
  if (signal.aborted || !videoTracks.some(track => track.readyState === 'live')) { release(); return null; }
  return { stream, release };
}

async function cameraIds(): Promise<string[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return [...new Set(devices.filter(device => device.kind === 'videoinput'
      && device.deviceId && !['default', 'communications'].includes(device.deviceId)).map(device => device.deviceId))];
  } catch { return []; }
}

function exactDevice(constraints: MediaStreamConstraints): string | undefined {
  if (!constraints.video || typeof constraints.video !== 'object') return undefined;
  const device = constraints.video.deviceId;
  if (typeof device === 'object' && !Array.isArray(device) && typeof device.exact === 'string') return device.exact;
  return undefined;
}

function constraintsFor(constraints: MediaStreamConstraints, deviceId?: string): MediaStreamConstraints {
  return {
    ...constraints,
    audio: false,
    video: deviceId ? { ...(typeof constraints.video === 'object' ? constraints.video : {}), deviceId: { exact: deviceId } } : constraints.video,
  };
}

/** Select an unused physical camera unless this mirror already has an explicit camera choice. */
export async function acquireComputerCamera(
  constraints: MediaStreamConstraints,
  signal: AbortSignal,
  preferredDeviceId?: string,
  waitForRelease = false,
): Promise<OwnedComputerCamera | null> {
  if (signal.aborted) return null;
  const preferred = preferredDeviceId || exactDevice(constraints);

  const capture = async (deviceId?: string): Promise<OwnedComputerCamera | null> => {
    let lease: CameraLease | null = deviceId ? await claimReleasedCamera(deviceId, signal, waitForRelease) : null;
    if (signal.aborted) { lease?.release(); return null; }
    if (deviceId && !lease) throw new ComputerCameraBusyError();
    let stream: MediaStream | null = null;
    try {
      if (signal.aborted) return null;
      stream = await acquireExhibitionCamera(constraintsFor(constraints, deviceId), signal);
      if (!stream || signal.aborted) return null;
      const actualId = cameraTrackDeviceId(stream.getVideoTracks()[0]);
      if (deviceId && actualId && deviceId !== actualId) throw new Error('摄像头与所选设备不一致，请重新选择。');
      if (!lease) {
        // Permission may hide IDs until the first capture. Reserve the actual camera before exposing it.
        lease = await claimCamera(actualId || 'unidentified-default');
        if (!lease) throw new ComputerCameraBusyError();
      }
      const owned = ownCamera(stream, lease, signal);
      // Ownership now includes cleanup, including cancellation between capture and this point.
      stream = null; lease = null;
      return owned;
    } finally {
      if (stream) stopTracks(stream);
      lease?.release();
    }
  };

  if (preferred) return capture(preferred);

  let candidates = await cameraIds();
  if (signal.aborted) return null;
  let lastFailure: unknown;
  if (!candidates.length) {
    try { return await capture(); }
    catch (cause) {
      if (signal.aborted) return null;
      if (!(cause instanceof ComputerCameraBusyError)) throw cause;
      lastFailure = cause;
      candidates = await cameraIds();
    }
  }
  for (const deviceId of candidates) {
    if (signal.aborted) return null;
    try { return await capture(deviceId); }
    catch (cause) {
      if (signal.aborted) return null;
      const unavailable = cause instanceof ComputerCameraBusyError
        || (cause instanceof Error && ['NotReadableError', 'NotFoundError', 'OverconstrainedError', 'AbortError'].includes(cause.name));
      if (!unavailable) throw cause;
      lastFailure = cause;
    }
  }
  throw lastFailure ?? new ComputerCameraBusyError();
}
