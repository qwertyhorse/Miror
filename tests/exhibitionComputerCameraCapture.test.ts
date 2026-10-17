import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireComputerCamera } from '../src/exhibition/computerCameraCapture';

const mocks = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock('../src/exhibition/cameraCapture', async importOriginal => ({
  ...await importOriginal<typeof import('../src/exhibition/cameraCapture')>(),
  acquireExhibitionCamera: mocks.acquire,
}));

const constraints: MediaStreamConstraints = {
  audio: false,
  video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
};

function cameraStream(deviceId: string) {
  const target = new EventTarget();
  const track = Object.assign(target, {
    kind: 'video', readyState: 'live', getSettings: () => ({ deviceId }),
    stop: vi.fn(() => { track.readyState = 'ended'; }),
  });
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function devices(...ids: string[]) {
  return ids.map(deviceId => ({ kind: 'videoinput', deviceId, label: deviceId }));
}

let held: Set<string>;
let enumerateDevices: ReturnType<typeof vi.fn>;
let request: ReturnType<typeof vi.fn>;
beforeEach(() => {
  held = new Set();
  enumerateDevices = vi.fn(async () => devices('camera-a', 'camera-b'));
  request = vi.fn((name: string, options: LockOptions, callback: LockGrantedCallback) => {
    expect(options).toEqual({ mode: 'exclusive', ifAvailable: true });
    if (held.has(name)) return Promise.resolve(callback(null));
    held.add(name);
    return Promise.resolve(callback({ name, mode: 'exclusive' } as Lock)).finally(() => { held.delete(name); });
  });
  vi.stubGlobal('navigator', { locks: { request }, mediaDevices: { enumerateDevices } });
  mocks.acquire.mockReset().mockImplementation(async (value: MediaStreamConstraints) => {
    const id = (value.video as MediaTrackConstraints).deviceId as ConstrainDOMStringParameters;
    return cameraStream(id?.exact as string || 'camera-a').stream;
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('independent computer camera ownership', () => {
  it('waits for a revoked tab to release the selected camera before opening capture', async () => {
    vi.useFakeTimers();
    const first = await acquireComputerCamera(constraints, new AbortController().signal, 'camera-a');
    const next = acquireComputerCamera(constraints, new AbortController().signal, 'camera-a', true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.acquire).toHaveBeenCalledOnce();
    first!.release(); await vi.advanceTimersByTimeAsync(250);
    const camera = await next;
    expect(camera!.stream.getVideoTracks()[0].getSettings().deviceId).toBe('camera-a');
    expect(mocks.acquire).toHaveBeenCalledTimes(2); camera!.release();
  });

  it('bounds a takeover camera wait and never steals another mirror camera', async () => {
    vi.useFakeTimers();
    const first = await acquireComputerCamera(constraints, new AbortController().signal, 'camera-a');
    const rejected = expect(acquireComputerCamera(constraints, new AbortController().signal, 'camera-a', true)).rejects.toThrow('另一台智能镜');
    await vi.advanceTimersByTimeAsync(5000); await rejected;
    expect(mocks.acquire).toHaveBeenCalledOnce();
    expect(first!.stream.getVideoTracks()[0].readyState).toBe('live'); first!.release();
  });

  it('cancels a takeover camera wait without acquiring a late released camera', async () => {
    vi.useFakeTimers();
    const first = await acquireComputerCamera(constraints, new AbortController().signal, 'camera-a');
    const controller = new AbortController();
    const next = acquireComputerCamera(constraints, controller.signal, 'camera-a', true);
    await vi.advanceTimersByTimeAsync(500); controller.abort();
    await expect(next).resolves.toBeNull();
    first!.release(); await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.acquire).toHaveBeenCalledOnce();
  });

  it('reserves different physical cameras before simultaneous unconfigured mirrors open capture', async () => {
    mocks.acquire.mockImplementation(async (value: MediaStreamConstraints) => {
      const id = ((value.video as MediaTrackConstraints).deviceId as ConstrainDOMStringParameters).exact as string;
      expect(held.has(`exhibition-computer-camera:${id}`)).toBe(true);
      expect(value).toEqual({ ...constraints, video: { ...constraints.video as object, deviceId: { exact: id } } });
      return cameraStream(id).stream;
    });
    const [first, second] = await Promise.all([
      acquireComputerCamera(constraints, new AbortController().signal),
      acquireComputerCamera(constraints, new AbortController().signal),
    ]);
    expect(first!.stream.getVideoTracks()[0].getSettings().deviceId).toBe('camera-a');
    expect(second!.stream.getVideoTracks()[0].getSettings().deviceId).toBe('camera-b');
    expect(held.size).toBe(2);
    first!.release(); second!.release();
  });

  it('rejects a saved or explicit camera already owned by another mirror without silently using another camera', async () => {
    const first = await acquireComputerCamera(constraints, new AbortController().signal, 'camera-a');
    await expect(acquireComputerCamera(constraints, new AbortController().signal, 'camera-a'))
      .rejects.toThrow('这个摄像头正在供另一台智能镜使用，请选择其他摄像头。');
    await expect(acquireComputerCamera({ ...constraints, video: { deviceId: { exact: 'camera-a' } } }, new AbortController().signal))
      .rejects.toThrow('这个摄像头正在供另一台智能镜使用');
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    first!.release();
  });

  it('reports all cameras busy without disturbing the two running mirrors', async () => {
    const first = await acquireComputerCamera(constraints, new AbortController().signal);
    const second = await acquireComputerCamera(constraints, new AbortController().signal);
    await expect(acquireComputerCamera(constraints, new AbortController().signal)).rejects.toThrow('另一台智能镜');
    expect(mocks.acquire).toHaveBeenCalledTimes(2);
    expect(first!.stream.getVideoTracks()[0].readyState).toBe('live');
    expect(second!.stream.getVideoTracks()[0].readyState).toBe('live');
    first!.release(); second!.release();
  });

  it('stops capture and releases its lock exactly once, permitting another mirror to use it', async () => {
    const first = await acquireComputerCamera(constraints, new AbortController().signal, 'camera-a');
    first!.release(); first!.release();
    await Promise.resolve();
    expect(first!.stream.getVideoTracks()[0].stop).toHaveBeenCalledOnce();
    expect(held.size).toBe(0);
    const replacement = await acquireComputerCamera(constraints, new AbortController().signal, 'camera-a');
    expect(replacement).not.toBeNull();
    replacement!.release();
  });

  it('keeps a pending camera reserved until a late cancelled capture has stopped', async () => {
    const captured = cameraStream('camera-a');
    const pending = deferred<MediaStream>();
    mocks.acquire.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const opening = acquireComputerCamera(constraints, controller.signal, 'camera-a');
    await vi.waitFor(() => expect(mocks.acquire).toHaveBeenCalledOnce());
    controller.abort();
    await expect(acquireComputerCamera(constraints, new AbortController().signal, 'camera-a')).rejects.toThrow('另一台智能镜');
    pending.resolve(captured.stream);
    await expect(opening).resolves.toBeNull();
    expect(captured.track.stop).toHaveBeenCalledOnce();
    expect(held.size).toBe(0);
  });

  it.each(['abort', 'ended'] as const)('releases a running camera on %s and ignores later duplicate cleanup', async cause => {
    const captured = cameraStream('camera-a');
    mocks.acquire.mockResolvedValueOnce(captured.stream);
    const controller = new AbortController();
    const camera = await acquireComputerCamera(constraints, controller.signal, 'camera-a');
    if (cause === 'abort') controller.abort();
    else { captured.track.readyState = 'ended'; captured.track.dispatchEvent(new Event('ended')); }
    camera!.release(); controller.abort();
    await Promise.resolve();
    expect(captured.track.stop).toHaveBeenCalledOnce();
    expect(held.size).toBe(0);
  });

  it('does not reserve or open a camera when already cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(acquireComputerCamera(constraints, controller.signal, 'camera-a')).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled(); expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it('releases a failed request and surfaces permission errors without trying a different device', async () => {
    const error = new DOMException('denied', 'NotAllowedError');
    mocks.acquire.mockRejectedValueOnce(error);
    await expect(acquireComputerCamera(constraints, new AbortController().signal)).rejects.toBe(error);
    expect(held.size).toBe(0); expect(mocks.acquire).toHaveBeenCalledOnce();
    const camera = await acquireComputerCamera(constraints, new AbortController().signal, 'camera-a');
    expect(camera).not.toBeNull(); camera!.release();
  });

  it('tries another unconfigured camera if an available camera cannot open', async () => {
    mocks.acquire.mockRejectedValueOnce(new DOMException('driver busy', 'NotReadableError'));
    const camera = await acquireComputerCamera(constraints, new AbortController().signal);
    expect(camera!.stream.getVideoTracks()[0].getSettings().deviceId).toBe('camera-b');
    expect(held.has('exhibition-computer-camera:camera-a')).toBe(false);
    camera!.release();
  });

  it('claims the actual ID after permission and retries another camera if the default is already owned', async () => {
    const first = await acquireComputerCamera(constraints, new AbortController().signal, 'camera-a');
    enumerateDevices.mockResolvedValueOnce(devices('')).mockResolvedValueOnce(devices('camera-a', 'camera-b'));
    const defaultCapture = cameraStream('camera-a');
    mocks.acquire.mockResolvedValueOnce(defaultCapture.stream);
    const second = await acquireComputerCamera(constraints, new AbortController().signal);
    expect(defaultCapture.track.stop).toHaveBeenCalledOnce();
    expect(second!.stream.getVideoTracks()[0].getSettings().deviceId).toBe('camera-b');
    expect(first!.stream.getVideoTracks()[0].readyState).toBe('live');
    first!.release(); second!.release();
  });

  it('holds a default capture by its actual ID when enumeration initially hides camera IDs', async () => {
    enumerateDevices.mockResolvedValueOnce(devices(''));
    const camera = await acquireComputerCamera(constraints, new AbortController().signal);
    expect(held.has('exhibition-computer-camera:camera-a')).toBe(true);
    await expect(acquireComputerCamera(constraints, new AbortController().signal, 'camera-a')).rejects.toThrow('另一台智能镜');
    camera!.release();
  });

  it('releases a camera returned for the wrong exact device instead of displaying another mirror feed', async () => {
    const wrong = cameraStream('camera-b'); mocks.acquire.mockResolvedValueOnce(wrong.stream);
    await expect(acquireComputerCamera(constraints, new AbortController().signal, 'camera-a')).rejects.toThrow('摄像头与所选设备不一致');
    expect(wrong.track.stop).toHaveBeenCalledOnce(); expect(held.size).toBe(0);
  });

  it('preserves explicit camera selection without Web Locks support and always disables microphone capture', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices } });
    const camera = await acquireComputerCamera({ ...constraints, audio: true }, new AbortController().signal, 'camera-b');
    expect(mocks.acquire).toHaveBeenCalledWith({ audio: false, video: {
      ...constraints.video as object, deviceId: { exact: 'camera-b' },
    } }, expect.any(AbortSignal));
    expect(camera!.stream.getVideoTracks()[0].getSettings().deviceId).toBe('camera-b');
    camera!.release();
  });
});
