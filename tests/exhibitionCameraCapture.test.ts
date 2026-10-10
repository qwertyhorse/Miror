import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireExhibitionCamera, cameraTrackDeviceId } from '../src/exhibition/cameraCapture';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const constraints: MediaStreamConstraints = {
  audio: false,
  video: { deviceId: { exact: 'verified-usb' }, width: { ideal: 1080 }, height: { ideal: 1920 }, frameRate: { ideal: 30, max: 30 } },
};

function track(readyState: MediaStreamTrackState = 'live') {
  return { readyState, stop: vi.fn() } as unknown as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
}

function stream(videoTracks: MediaStreamTrack[], otherTracks: MediaStreamTrack[] = []) {
  return { getVideoTracks: () => videoTracks, getTracks: () => [...videoTracks, ...otherTracks] } as MediaStream;
}

function camera() {
  const getUserMedia = vi.fn<(value: MediaStreamConstraints) => Promise<MediaStream>>();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  return getUserMedia;
}

describe('exhibition camera capture recovery', () => {
  it('returns a live video stream immediately without releasing it', async () => {
    const video = track();
    const captured = stream([video]);
    const getUserMedia = camera().mockResolvedValue(captured);

    await expect(acquireExhibitionCamera(constraints, new AbortController().signal)).resolves.toBe(captured);

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0][0]).toBe(constraints);
    expect(video.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases ended and video-less captures before retrying the exact tested profile', async () => {
    const ended = track('ended');
    const audio = track();
    const live = track();
    const captured = stream([live]);
    const getUserMedia = camera()
      .mockResolvedValueOnce(stream([ended]))
      .mockResolvedValueOnce(stream([], [audio]))
      .mockResolvedValueOnce(captured);
    const acquiring = acquireExhibitionCamera(constraints, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(499);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(ended.stop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(audio.stop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1199);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(acquiring).resolves.toBe(captured);
    expect(getUserMedia).toHaveBeenCalledTimes(3);
    for (const [requested] of getUserMedia.mock.calls) expect(requested).toBe(constraints);
    expect(live.stop).not.toHaveBeenCalled();
  });

  it('recovers from busy and aborted driver requests within the same retry budget', async () => {
    const captured = stream([track()]);
    const getUserMedia = camera()
      .mockRejectedValueOnce(new DOMException('camera busy', 'NotReadableError'))
      .mockRejectedValueOnce(new DOMException('driver closing', 'AbortError'))
      .mockResolvedValueOnce(captured);
    const acquiring = acquireExhibitionCamera(constraints, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(500);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1200);

    await expect(acquiring).resolves.toBe(captured);
    expect(getUserMedia).toHaveBeenCalledTimes(3);
    for (const [requested] of getUserMedia.mock.calls) expect(requested).toBe(constraints);
  });

  it('stops every failed capture and surfaces persistent invalid video after three attempts', async () => {
    const videos = [track('ended'), track('ended'), track('ended')];
    const audios = [track(), track(), track()];
    const getUserMedia = camera();
    videos.forEach((video, index) => getUserMedia.mockResolvedValueOnce(stream([video], [audios[index]])));
    const failure = expect(acquireExhibitionCamera(constraints, new AbortController().signal))
      .rejects.toThrow('摄像头没有返回有效画面，请重新开启。');

    await vi.advanceTimersByTimeAsync(1700);
    await failure;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(getUserMedia).toHaveBeenCalledTimes(3);
    for (const released of [...videos, ...audios]) expect(released.stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('surfaces a persistent busy driver after the bounded retry budget', async () => {
    const error = new DOMException('camera busy', 'NotReadableError');
    const getUserMedia = camera().mockRejectedValue(error);
    const failure = expect(acquireExhibitionCamera(constraints, new AbortController().signal)).rejects.toBe(error);

    await vi.advanceTimersByTimeAsync(1700);
    await failure;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(getUserMedia).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['NotAllowedError', 'OverconstrainedError', 'NotFoundError', 'SecurityError'])(
    'does not retry or fall back to another device for %s', async name => {
      const error = new DOMException('capture rejected', name);
      const getUserMedia = camera().mockRejectedValue(error);

      await expect(acquireExhibitionCamera(constraints, new AbortController().signal)).rejects.toBe(error);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(getUserMedia.mock.calls[0][0]).toBe(constraints);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not open the camera after cancellation', async () => {
    const getUserMedia = camera();
    const controller = new AbortController();
    controller.abort();

    await expect(acquireExhibitionCamera(constraints, controller.signal)).resolves.toBeNull();

    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('cancels a delayed retry and clears its timer when leaving the camera page', async () => {
    const ended = track('ended');
    const getUserMedia = camera().mockResolvedValue(stream([ended]));
    const controller = new AbortController();
    const acquiring = acquireExhibitionCamera(constraints, controller.signal);
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(1);

    controller.abort();

    await expect(acquiring).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(ended.stop).toHaveBeenCalledTimes(1);
  });

  it('releases all tracks when a pending camera request succeeds after cancellation', async () => {
    let grant!: (captured: MediaStream) => void;
    const getUserMedia = camera().mockReturnValue(new Promise(resolve => { grant = resolve; }));
    const controller = new AbortController();
    const acquiring = acquireExhibitionCamera(constraints, controller.signal);
    controller.abort();
    const video = track();
    const audio = track();

    grant(stream([video], [audio]));

    await expect(acquiring).resolves.toBeNull();
    expect(video.stop).toHaveBeenCalledTimes(1);
    expect(audio.stop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('camera track device settings', () => {
  it('reads the device ID when track settings are available', () => {
    expect(cameraTrackDeviceId({ getSettings: () => ({ deviceId: 'verified-usb' }) } as MediaStreamTrack)).toBe('verified-usb');
  });

  it.each([
    {},
    { getSettings: () => ({}) },
    { getSettings: () => { throw new Error('driver settings unavailable'); } },
  ])('tolerates unavailable track settings: %j', value => {
    expect(cameraTrackDeviceId(value as MediaStreamTrack)).toBe('');
  });
});
