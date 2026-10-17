import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { CAMERA_RESOLUTION_OPTIONS, COMPUTER_RESOLUTION_OPTIONS, computerCameraProfile, computerCameraQuality, computerDisplayFrameRate, computerDisplayProfile, computerDisplayQuality, isComputerCameraResolution, isComputerResolution } from '../src/exhibition/cameraQuality';
import { ComputerDisplaySender, defaultComputerCameraEntry, exhibitionComputerUrl, exhibitionWirelessUrl, type ComputerDisplayPoll, type ComputerDisplaySignal } from '../src/exhibition/computerDisplay';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const session = { sessionId: 'host-1', terminalId: 'desktop-host-1', token: 'ephemeral-token' };
const track = (name: string, width = 1920, height = 1080) => ({ id: name, readyState: 'live', kind: 'video', stop: vi.fn(), getSettings: () => ({ width, height }) }) as unknown as MediaStreamTrack;
const stream = (video: MediaStreamTrack) => ({ getVideoTracks: () => [video], getAudioTracks: () => [] }) as unknown as MediaStream;

class FakePeer {
  signalingState = 'stable'; connectionState = 'new'; localDescription: RTCSessionDescriptionInit | null = null; remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((event: { candidate: { toJSON(): RTCIceCandidateInit } | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  sender = { track: null as MediaStreamTrack | null, getParameters: vi.fn(() => ({ encodings: [{}] })), setParameters: vi.fn(async (_value: unknown) => {}),
    replaceTrack: vi.fn(async (value: MediaStreamTrack | null) => { this.sender.track = value; }) };
  transceiver = { sender: this.sender, setCodecPreferences: vi.fn() };
  addTransceiver = vi.fn((value: MediaStreamTrack | string, _options: unknown) => { this.sender.track = typeof value === 'string' ? null : value; return this.transceiver; });
  createOffer = vi.fn(async () => ({ type: 'offer' as const, sdp: 'v=0\r\na=sendonly\r\n' }));
  setLocalDescription = vi.fn(async (offer: RTCSessionDescriptionInit) => { this.localDescription = offer; this.signalingState = 'have-local-offer'; this.candidate('local-candidate'); });
  setRemoteDescription = vi.fn(async (answer: RTCSessionDescriptionInit) => { this.remoteDescription = answer; this.signalingState = 'stable'; });
  addIceCandidate = vi.fn(async (_candidate: RTCIceCandidateInit) => {});
  getStats = vi.fn(async () => new Map());
  close = vi.fn(() => { this.connectionState = 'closed'; });
  candidate(value: string) { this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: value, sdpMid: '0', sdpMLineIndex: 0 }) } }); }
}

function fixture(output: 'android' | 'browser' = 'android') {
  let epoch = 0; let cursor = 0; let receiverOnline = true; let supportsPage = false; let supportsPageAck = false;
  const messages: ComputerDisplayPoll['messages'] = [{ sequence: ++cursor, kind: 'ready', payload: { epoch: 0 } }];
  const peers: FakePeer[] = [];
  const request = vi.fn(async (action: string, body: any) => {
    if (action === 'open') return session;
    if (action === 'poll') return { messages: messages.splice(0), epoch, cursor, receiverOnline,
      ...(supportsPage ? { receiverCapabilities: ['page', ...(supportsPageAck ? ['page-rendered'] : [])] } : {}) };
    if (action === 'signal' && body.kind === 'offer') epoch = body.payload.epoch;
    return {};
  });
  const change = vi.fn(); const receiverExpired = vi.fn(); const connectionLost = vi.fn(); const stats = vi.fn(); const qualityError = vi.fn();
  const sender = new ComputerDisplaySender('mirror/a', 'screen-unique', { change, receiverExpired, connectionLost, stats, qualityError }, {
    request: request as any, peer: () => { const peer = new FakePeer(); peers.push(peer); return peer as unknown as RTCPeerConnection; },
    codecs: () => [{ mimeType: 'video/VP8', clockRate: 90000 }, { mimeType: 'video/H264', clockRate: 90000 }, { mimeType: 'video/rtx', clockRate: 90000 }],
    now: () => Date.now(),
  }, output);
  const push = (message: ComputerDisplaySignal) => { messages.push({ ...message, sequence: ++cursor }); };
  return { sender, request, peers, change, receiverExpired, connectionLost, stats, qualityError, push, offline() { receiverOnline = false; }, online() { receiverOnline = true; }, advanceEpoch() { epoch++; push({ kind: 'ready', payload: { epoch } }); },
    pageSupport(value = true, ack = true) { supportsPage = value; supportsPageAck = ack; },
    signals(kind: string) { return request.mock.calls.filter(([action, body]) => action === 'signal' && body.kind === kind).map(([, body]) => body.payload); } };
}

let running: ComputerDisplaySender[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { running.forEach(sender => sender.close()); running = []; vi.useRealTimers(); });
function setup(output: 'android' | 'browser' = 'android') { const f = fixture(output); running.push(f.sender); return f; }

describe('computer display sender', () => {
  it('forwards explicit takeover through the release wait without retrying other failures', async () => {
    const f = setup(); f.request.mockRejectedValueOnce(new ApiError('正在停止', 'DISPLAY_MIRROR_BUSY'));
    const starting = f.sender.start({ waitForRelease: true, replaceHost: true });
    await vi.advanceTimersByTimeAsync(500); await starting;
    const opens = f.request.mock.calls.filter(([action]) => action === 'open');
    expect(opens).toHaveLength(2);
    expect(opens.every(([, body]) => body.replaceHost === true)).toBe(true);
    expect(f.change.mock.calls.at(-1)?.[0].session).toEqual(session);
  });

  it('does not automatically take back a host after its capability is revoked', async () => {
    const f = setup(); await f.sender.start();
    f.request.mockRejectedValueOnce(new ApiError('身份无效', 'DISPLAY_UNAUTHORIZED'));
    await vi.advanceTimersByTimeAsync(25000);
    expect(f.change.mock.calls.at(-1)?.[0]).toMatchObject({ session: null, status: 'error' });
    expect(f.request.mock.calls.filter(([action]) => action === 'open')).toHaveLength(1);
    expect(f.peers[0].close).toHaveBeenCalled();
  });

  it('keeps the authenticated close request alive when the page unloads', async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/open') ? session
      : { messages: [], epoch: 0, cursor: 0, receiverOnline: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const sender = new ComputerDisplaySender('mirror', 'computer-one', { change: vi.fn() }, {}, 'browser');
      running.push(sender); await sender.start(); sender.close();
      const close = fetchMock.mock.calls.find(([url]) => url.endsWith('/close')) as unknown as [string, RequestInit];
      expect(close[1].keepalive).toBe(true);
      expect(JSON.parse(close[1].body as string)).toEqual({ sessionId: session.sessionId, token: session.token });
    } finally { vi.unstubAllGlobals(); }
  });

  it('opens wireless presentation on secure camera origin with Android transport and the selected mirror', () => {
    const url = new URL(exhibitionWirelessUrl('east/2', 'http://xuminghong.local:10601/v1.1/exhibition/control'));
    expect(url.origin).toBe('https://xuminghong.local:10202');
    expect(url.pathname).toMatch(/\/exhibition\/computer$/);
    expect(url.searchParams.get('mirror')).toBe('east/2');
    expect(url.searchParams.get('presentation')).toBe('wireless');
    expect(url.searchParams.has('output')).toBe(false);
  });

  it('withholds captured page tracks until the current Android receiver advertises full-page support', async () => {
    const f = setup(); const page = track('page', 1080, 1920);
    await f.sender.setSource(stream(page), { source: 'page', mirrored: true, rotation: 90 }); await f.sender.start();
    expect(f.peers[0].sender.track).toBeNull(); expect(f.signals('presentation')).toEqual([]);
    expect(f.change.mock.calls.at(-1)?.[0].receiverSupportsPage).toBe(false);
    f.pageSupport(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.peers[0].close).toHaveBeenCalledOnce(); expect(f.peers[1].sender.track).toBe(page);
    expect(f.signals('presentation').at(-1)).toEqual({ epoch: 2, source: 'page', mirrored: false, active: true, presentationId: 1 });
    expect(f.change.mock.calls.at(-1)?.[0].receiverSupportsPage).toBe(true);
    f.pageSupport(false); await vi.advanceTimersByTimeAsync(1000);
    expect(f.peers[1].close).toHaveBeenCalledOnce(); expect(f.peers[2].sender.track).toBeNull();
    expect(page.stop).not.toHaveBeenCalled();
  });

  it('detaches stopped page capture and clears the remote frame without reopening ownership or stopping borrowed tracks', async () => {
    const f = setup(); f.pageSupport(); const page = track('page');
    await f.sender.setSource(stream(page), { source: 'page', mirrored: false }); await f.sender.start();
    const peer = f.peers[0];
    await f.sender.setSource(null, { source: 'page', mirrored: false });
    expect(peer.sender.replaceTrack).toHaveBeenLastCalledWith(null); expect(peer.sender.track).toBeNull();
    expect(f.signals('presentation').at(-1)).toEqual({ epoch: 1, source: 'page', mirrored: false, active: false, presentationId: 2 });
    expect(f.peers).toHaveLength(1); expect(f.request.mock.calls.filter(([action]) => action === 'open')).toHaveLength(1);
    f.advanceEpoch(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.peers[1].sender.track).toBeNull();
    expect(f.signals('presentation').at(-1)).toEqual({ epoch: 3, source: 'page', mirrored: false, active: false, presentationId: 2 });
    expect(page.stop).not.toHaveBeenCalled();
  });

  it('distinguishes a new page capture negotiation from actual page connection loss', async () => {
    const f = setup(); f.pageSupport(); await f.sender.setSource(null, { source: 'page', mirrored: false }); await f.sender.start();
    const peer = f.peers[0]; peer.connectionState = 'connected'; peer.onconnectionstatechange?.();
    await f.sender.setSource(stream(track('page')), { source: 'page', mirrored: false });
    expect(f.peers).toHaveLength(2); expect(f.change.mock.calls.at(-1)?.[0].status).toBe('connecting');
    expect(f.connectionLost).not.toHaveBeenCalled();
    const next = f.peers[1]; next.connectionState = 'connected'; next.onconnectionstatechange?.();
    next.connectionState = 'disconnected'; next.onconnectionstatechange?.();
    next.connectionState = 'failed'; next.onconnectionstatechange?.();
    expect(f.connectionLost).toHaveBeenCalledOnce();
  });

  it('maintains page resolution at every quality while ordinary camera settings stay unchanged', async () => {
    const f = setup(); f.pageSupport(); await f.sender.setSource(stream(track('page', 502, 892)), { source: 'page', mirrored: false }); await f.sender.start();
    for (const quality of ['1080p', 'l1', 'l2', 'l3', 'l4'] as const) {
      await f.sender.setQuality(quality, 15);
      expect(f.peers[0].sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ degradationPreference: 'maintain-resolution' }));
    }
    await f.sender.setSource(stream(track('camera')), { source: 'camera', mirrored: true });
    expect(f.peers[0].sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ degradationPreference: 'maintain-framerate' }));
  });

  it('requires the current rendered batch and epoch, clearing confirmation on stop, new capture and reconnect', async () => {
    const f = setup(); f.pageSupport(); const capture = stream(track('page'));
    await f.sender.setSource(capture, { source: 'page', mirrored: false }); await f.sender.start();
    const rendered = (epoch: number, presentationId: number) => f.push({ kind: 'rendered', payload: { epoch, presentationId } });
    const confirmed = () => f.change.mock.calls.at(-1)?.[0].receiverRenderedPage;
    expect(confirmed()).toBe(false);
    rendered(0, 1); rendered(1, 99); await vi.advanceTimersByTimeAsync(1000); expect(confirmed()).toBe(false);
    rendered(1, 1); await vi.advanceTimersByTimeAsync(1000); expect(confirmed()).toBe(true);
    await f.sender.setSource(capture, { source: 'page', mirrored: false });
    expect(confirmed()).toBe(true); expect(f.peers).toHaveLength(1);
    await f.sender.setSource(null, { source: 'page', mirrored: false }); expect(confirmed()).toBe(false);
    rendered(1, 1); rendered(1, 2); await vi.advanceTimersByTimeAsync(1000); expect(confirmed()).toBe(false);
    await f.sender.setSource(stream(track('new-page')), { source: 'page', mirrored: false });
    expect(f.peers).toHaveLength(2); expect(f.signals('presentation').at(-1)).toMatchObject({ epoch: 2, presentationId: 3, active: true });
    rendered(1, 3); rendered(2, 1); await vi.advanceTimersByTimeAsync(1000); expect(confirmed()).toBe(false);
    rendered(2, 3); await vi.advanceTimersByTimeAsync(1000); expect(confirmed()).toBe(true);
    f.advanceEpoch(); await vi.advanceTimersByTimeAsync(1000); expect(confirmed()).toBe(false);
    rendered(2, 3); await vi.advanceTimersByTimeAsync(1000); expect(confirmed()).toBe(false);
    rendered(4, 3); await vi.advanceTimersByTimeAsync(1000); expect(confirmed()).toBe(true);
    f.peers.at(-1)!.connectionState = 'disconnected'; f.peers.at(-1)!.onconnectionstatechange?.(); expect(confirmed()).toBe(false);
  });

  it('keeps legacy page receivers waiting without rendered feedback while still carrying their video', async () => {
    const f = setup(); f.pageSupport(true, false); const page = track('page');
    await f.sender.setSource(stream(page), { source: 'page', mirrored: false }); await f.sender.start();
    f.peers[0].connectionState = 'connected'; f.peers[0].onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.peers[0].sender.track).toBe(page);
    expect(f.change.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'connected', receiverRenderedPage: false, receiverSupportsPage: true, receiverSupportsPageAck: false });
  });

  it.each(['accepted', 'failed', 'stopped'] as const)('fences a rendered ACK arriving before publication response: %s', async outcome => {
    const f = setup(); f.pageSupport(); await f.sender.setSource(null, { source: 'page', mirrored: false }); await f.sender.start();
    const original = f.request.getMockImplementation()!;
    const publication = deferred<{}>(); const earlyAck = deferred<void>();
    f.request.mockImplementation(async (action, body) => {
      if (action === 'signal' && body.kind === 'presentation' && body.payload.active) {
        // Re-entrant delivery models a receiver whose independent poll/ACK wins
        // the race with the delayed HTTP response to the presentation request.
        await (f.sender as unknown as { receive(message: ComputerDisplaySignal): Promise<void> }).receive({
          kind: 'rendered', payload: { epoch: body.payload.epoch, presentationId: body.payload.presentationId },
        });
        earlyAck.resolve(); return publication.promise;
      }
      return original(action, body);
    });
    const sharing = f.sender.setSource(stream(track('page')), { source: 'page', mirrored: false });
    const settled = sharing.then(() => true, () => false);
    await earlyAck.promise;
    expect(f.change.mock.calls.at(-1)?.[0].receiverRenderedPage).toBe(false);
    const stopping = outcome === 'stopped' ? f.sender.setSource(null, { source: 'page', mirrored: false }) : null;
    if (outcome === 'failed') publication.reject(new Error('Publication rejected'));
    else publication.resolve({});
    await settled; await stopping;
    expect(f.change.mock.calls.at(-1)?.[0].receiverRenderedPage).toBe(outcome === 'accepted');
    if (outcome !== 'accepted') expect(f.change.mock.calls.some(([value]) => value.receiverRenderedPage)).toBe(false);
  });

  it('exposes page-rendered capability separately and revokes confirmation when the capability disappears', async () => {
    const f = setup(); f.pageSupport(); await f.sender.setSource(stream(track('page')), { source: 'page', mirrored: false }); await f.sender.start();
    f.push({ kind: 'rendered', payload: { epoch: 1, presentationId: 1 } }); await vi.advanceTimersByTimeAsync(1000);
    expect(f.change.mock.calls.at(-1)?.[0]).toMatchObject({ receiverSupportsPage: true, receiverSupportsPageAck: true, receiverRenderedPage: true });
    f.pageSupport(true, false); f.push({ kind: 'rendered', payload: { epoch: 1, presentationId: 1 } }); await vi.advanceTimersByTimeAsync(1000);
    expect(f.change.mock.calls.at(-1)?.[0]).toMatchObject({ receiverSupportsPage: true, receiverSupportsPageAck: false, receiverRenderedPage: false });
    f.offline(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.change.mock.calls.at(-1)?.[0]).toMatchObject({ receiverSupportsPage: false, receiverSupportsPageAck: false, receiverRenderedPage: false });
  });

  it('reports a receiver restart as page connection loss even before ICE detects it', async () => {
    const f = setup(); f.pageSupport(); await f.sender.setSource(stream(track('page')), { source: 'page', mirrored: false }); await f.sender.start();
    expect(f.connectionLost).not.toHaveBeenCalled();
    f.advanceEpoch(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.connectionLost).toHaveBeenCalledOnce(); expect(f.peers).toHaveLength(2);
  });

  it('shares resolution options while preserving existing values and fallback defaults', () => {
    expect(computerCameraQuality('2k')).toBe('1080p'); expect(computerDisplayQuality('2k')).toBe('2k');
    expect(computerDisplayQuality('4k')).toBe('4k'); expect(computerDisplayQuality('8k')).toBe('1080p');
    expect([15, 24, 30, 60, undefined].map(computerDisplayFrameRate)).toEqual([15, 24, 30, 30, 30]);
    expect(computerDisplayProfile('2k')).toEqual({ width: 2560, height: 1440, maxBitrate: 12_000_000 });
    expect(COMPUTER_RESOLUTION_OPTIONS.map(option => option.value)).toEqual(['1080p', '2k', '4k', 'l1', 'l2', 'l3', 'l4']);
    expect(CAMERA_RESOLUTION_OPTIONS.map(option => option.value)).toEqual(['1080p', '4k', 'l1', 'l2', 'l3', 'l4']);
    for (const { value } of COMPUTER_RESOLUTION_OPTIONS) {
      expect(isComputerResolution(value)).toBe(true);
      expect(computerDisplayQuality(value)).toBe(value);
      if (value === '2k') expect(isComputerCameraResolution(value)).toBe(false);
      else {
        expect(isComputerCameraResolution(value)).toBe(true); expect(computerCameraQuality(value)).toBe(value);
        expect(computerCameraProfile(value)).toEqual(computerDisplayProfile(value));
      }
    }
    for (const value of ['8k', 'L1', '__proto__', 'constructor', '', null, undefined, 4]) {
      expect(isComputerResolution(value)).toBe(false);
      expect(isComputerCameraResolution(value)).toBe(false);
      expect(computerCameraQuality(value)).toBe('1080p'); expect(computerDisplayQuality(value)).toBe('1080p');
    }
  });

  it.each([
    ['l1', 1920, 1024, 5_700_000, 'L1 · 1024 × 1920'],
    ['l2', 1536, 818, 3_600_000, 'L2 · 818 × 1536'],
    ['l3', 1248, 664, 2_400_000, 'L3 · 664 × 1248'],
    ['l4', 960, 512, 1_400_000, 'L4 · 512 × 960'],
  ] as const)('applies %s portrait reference bounds to landscape and portrait 4K without changing the source', async (quality, width, height, maxBitrate, label) => {
    expect(COMPUTER_RESOLUTION_OPTIONS.find(option => option.value === quality)?.label).toBe(label);
    expect(computerCameraProfile(quality)).toEqual({ width, height, maxBitrate });
    for (const [sourceWidth, sourceHeight] of [[3840, 2160], [2160, 3840]]) {
      const f = setup(); const camera = track('camera', sourceWidth, sourceHeight);
      await f.sender.setSource(stream(camera), { source: 'camera', mirrored: true }); await f.sender.start();
      await f.sender.setQuality(quality, 24);
      const peer = f.peers[0];
      const scale = Math.max(3840 / width, 2160 / height);
      expect(peer.sender.setParameters).toHaveBeenLastCalledWith({ degradationPreference: 'maintain-framerate', encodings: [{ maxBitrate, maxFramerate: 24, scaleResolutionDownBy: scale }] });
      expect(3840 / scale).toBeLessThanOrEqual(width); expect(2160 / scale).toBeLessThanOrEqual(height);
      expect(peer.sender.track).toBe(camera); expect(peer.sender.replaceTrack).not.toHaveBeenCalled();
      expect(peer.close).not.toHaveBeenCalled(); expect(camera.stop).not.toHaveBeenCalled(); expect(f.peers).toHaveLength(1);
    }
  });

  it.each(['l1', 'l2', 'l3', 'l4'] as const)('never enlarges a smaller cloud stream for %s', async quality => {
    const f = setup(); const generated = track('cloud', 256, 480);
    await f.sender.setQuality(quality, 15); await f.sender.setSource(stream(generated), { source: 'output', mirrored: false }); await f.sender.start();
    expect(f.peers[0].sender.setParameters).toHaveBeenLastCalledWith({ degradationPreference: 'maintain-framerate', encodings: [{ maxBitrate: computerDisplayProfile(quality).maxBitrate, maxFramerate: 15, scaleResolutionDownBy: 1 }] });
    expect(generated.stop).not.toHaveBeenCalled();
  });

  it('keeps the selected L-series limits after replacing the camera with cloud output and reconnecting the receiver', async () => {
    const f = setup(); await f.sender.setQuality('l2', 24);
    await f.sender.setSource(stream(track('camera', 3840, 2160)), { source: 'camera', mirrored: true, rotation: 90 }); await f.sender.start();
    const output = track('cloud', 1024, 1920); await f.sender.setSource(stream(output), { source: 'output', mirrored: false });
    const expected = { degradationPreference: 'maintain-framerate', encodings: [{ maxBitrate: 3_600_000, maxFramerate: 24, scaleResolutionDownBy: Math.max(1920 / 1536, 1024 / 818) }] };
    expect(f.peers[0].sender.setParameters).toHaveBeenLastCalledWith(expected);
    f.advanceEpoch(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.peers[1].sender.setParameters).toHaveBeenLastCalledWith(expected); expect(output.stop).not.toHaveBeenCalled();
  });

  it.each([15, 24, 30] as const)('changes 4K input to 2K at %d fps using the existing sender and original track', async frameRate => {
    const f = setup(); const camera = track('camera', 3840, 2160);
    await f.sender.setSource(stream(camera), { source: 'camera', mirrored: true }); await f.sender.start();
    const peer = f.peers[0]; await f.sender.setQuality('2k', frameRate);
    expect(peer.sender.setParameters).toHaveBeenLastCalledWith({ degradationPreference: 'maintain-resolution', encodings: [{ maxBitrate: 12_000_000, maxFramerate: frameRate, scaleResolutionDownBy: 1.5 }] });
    expect(peer.sender.track).toBe(camera); expect(peer.sender.replaceTrack).not.toHaveBeenCalled();
    expect(f.peers).toHaveLength(1); expect(f.signals('offer')).toHaveLength(1); expect(camera.stop).not.toHaveBeenCalled();
    expect(f.qualityError).toHaveBeenLastCalledWith('');
  });

  it('keeps the output frame cap after switching to a smaller cloud track and receiver reconnect', async () => {
    const f = setup(); const generated = track('cloud', 832, 1504);
    await f.sender.setQuality('2k', 24); await f.sender.setSource(stream(track('camera', 3840, 2160)), { source: 'camera', mirrored: false });
    await f.sender.start(); await f.sender.setSource(stream(generated), { source: 'output', mirrored: false });
    expect(f.peers[0].sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [{ maxBitrate: 12_000_000, maxFramerate: 24, scaleResolutionDownBy: 1 }] }));
    f.advanceEpoch(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.peers[1].sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [{ maxBitrate: 12_000_000, maxFramerate: 24, scaleResolutionDownBy: 1 }] }));
    expect(generated.stop).not.toHaveBeenCalled();
  });

  it('reports a rejected running setting and preserves the last accepted output without recreating the peer', async () => {
    const f = setup(); await f.sender.setSource(stream(track('camera', 3840, 2160)), { source: 'camera', mirrored: false }); await f.sender.start();
    await f.sender.setQuality('2k', 24);
    const peer = f.peers[0]; peer.sender.setParameters.mockRejectedValueOnce(new Error('encoder rejected'));
    await expect(f.sender.setQuality('4k', 15)).rejects.toThrow('输出设置未生效，请重试。');
    expect(f.qualityError).toHaveBeenLastCalledWith('输出设置未生效，请重试。'); expect(peer.close).not.toHaveBeenCalled();
    await f.sender.setSource(stream(track('next-camera', 3840, 2160)), { source: 'camera', mirrored: false });
    expect(peer.sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [{ maxBitrate: 12_000_000, maxFramerate: 24, scaleResolutionDownBy: 1.5 }] }));
    expect(f.qualityError).toHaveBeenLastCalledWith('输出设置未生效，请重试。'); expect(f.peers).toHaveLength(1);
    await f.sender.setQuality('4k', 15); expect(f.qualityError).toHaveBeenLastCalledWith('');
  });

  it('reports missing encoding controls instead of pretending that a running setting succeeded', async () => {
    const f = setup(); await f.sender.setSource(stream(track('camera')), { source: 'camera', mirrored: false }); await f.sender.start();
    f.peers[0].sender.getParameters.mockReturnValueOnce({ encodings: [] });
    await expect(f.sender.setQuality('2k', 24)).rejects.toThrow('输出设置未生效，请重试。');
    expect(f.qualityError).toHaveBeenLastCalledWith('输出设置未生效，请重试。'); expect(f.peers[0].close).not.toHaveBeenCalled();
  });

  it('reports saved-parameter failures during the first offer without closing its video connection', async () => {
    const f = setup(); const offering = deferred<void>(); const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (action, body) => { if (action === 'signal' && body.kind === 'offer') await offering.promise; return original(action, body); });
    await f.sender.setQuality('4k', 15); await f.sender.setSource(stream(track('camera')), { source: 'camera', mirrored: false });
    const starting = f.sender.start(); await vi.advanceTimersByTimeAsync(0);
    f.peers[0].sender.setParameters.mockRejectedValueOnce(new Error('unsupported')); offering.resolve(); await starting;
    expect(f.qualityError).toHaveBeenLastCalledWith('输出设置未生效，请重试。'); expect(f.peers[0].close).not.toHaveBeenCalled();
    expect(f.signals('presentation')).toHaveLength(1); expect(f.peers).toHaveLength(1);
  });

  it('retains the connection when encoder parameters fail after replacing a track', async () => {
    const f = setup(); await f.sender.setSource(stream(track('camera')), { source: 'camera', mirrored: false }); await f.sender.start();
    const peer = f.peers[0]; peer.sender.setParameters.mockRejectedValueOnce(new Error('unsupported'));
    const output = track('cloud', 832, 1504); await f.sender.setSource(stream(output), { source: 'output', mirrored: false });
    expect(f.qualityError).toHaveBeenLastCalledWith('输出设置未生效，请重试。'); expect(peer.close).not.toHaveBeenCalled();
    expect(peer.sender.track).toBe(output); expect(f.peers).toHaveLength(1); expect(f.signals('presentation').at(-1)?.source).toBe('output');
  });

  it('does not let a superseded failed update roll back a newer queued request', async () => {
    const f = setup(); await f.sender.setSource(stream(track('camera', 3840, 2160)), { source: 'camera', mirrored: false }); await f.sender.start();
    const changing = deferred<void>(); const peer = f.peers[0]; peer.sender.setParameters.mockImplementationOnce(() => changing.promise);
    f.qualityError.mockClear();
    const first = f.sender.setQuality('4k', 15); const rejected = expect(first).rejects.toThrow('输出设置未生效'); await vi.advanceTimersByTimeAsync(0);
    const latest = f.sender.setQuality('2k', 24); changing.reject(new Error('unsupported')); await rejected; await latest;
    expect(peer.sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [{ maxBitrate: 12_000_000, maxFramerate: 24, scaleResolutionDownBy: 1.5 }] }));
    expect(f.qualityError.mock.calls).toEqual([['']]); expect(f.peers).toHaveLength(1);
  });

  it('restores the last successfully applied update when the next queued update fails', async () => {
    const f = setup(); await f.sender.setSource(stream(track('camera', 3840, 2160)), { source: 'camera', mirrored: false }); await f.sender.start();
    const changing = deferred<void>(); const peer = f.peers[0]; peer.sender.setParameters.mockImplementationOnce(() => changing.promise).mockRejectedValueOnce(new Error('unsupported'));
    const first = f.sender.setQuality('2k', 24); await vi.advanceTimersByTimeAsync(0);
    const latest = f.sender.setQuality('4k', 15); const rejected = expect(latest).rejects.toThrow('输出设置未生效');
    changing.resolve(); await first; await rejected;
    await f.sender.setSource(stream(track('next-camera', 3840, 2160)), { source: 'camera', mirrored: false });
    expect(peer.sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [{ maxBitrate: 12_000_000, maxFramerate: 24, scaleResolutionDownBy: 1.5 }] }));
    expect(f.qualityError).toHaveBeenLastCalledWith('输出设置未生效，请重试。');
  });

  it('reports a busy mirror without retrying until stopping is explicitly requested', async () => {
    const f = setup(); f.request.mockRejectedValue(new ApiError('请先结束当前体验，再连接电脑。', 'DISPLAY_MIRROR_BUSY'));
    await f.sender.start(); await vi.advanceTimersByTimeAsync(25000);
    expect(f.request).toHaveBeenCalledOnce(); expect(f.peers).toHaveLength(0);
    expect(f.change.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'error', session: null, errorCode: 'DISPLAY_MIRROR_BUSY' });
    expect(f.change.mock.calls.some(([state]) => state.status === 'releasing')).toBe(false);
  });

  it('waits for backend release after an explicit stop before opening the host', async () => {
    const f = setup(); f.request.mockRejectedValueOnce(new ApiError('正在停止', 'DISPLAY_MIRROR_BUSY'));
    const starting = f.sender.start({ waitForRelease: true }); await vi.advanceTimersByTimeAsync(0);
    expect(f.change.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'releasing', session: null, error: '' });
    expect(f.peers).toHaveLength(0); expect(f.request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500); await starting;
    expect(f.request.mock.calls.filter(([action]) => action === 'open')).toHaveLength(2);
    expect(f.change.mock.calls.at(-1)?.[0]).toMatchObject({ session, error: '' });
    expect(f.change.mock.calls.at(-1)?.[0].errorCode).toBeUndefined(); expect(f.peers).toHaveLength(1);
  });

  it('ends the release wait after twenty seconds without bypassing a busy mirror', async () => {
    const f = setup(); f.request.mockRejectedValue(new ApiError('正在停止', 'DISPLAY_MIRROR_BUSY'));
    const starting = f.sender.start({ waitForRelease: true });
    await vi.advanceTimersByTimeAsync(20000); await starting;
    expect(f.change.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'error', session: null, error: '停止状态未确认，请重试。', errorCode: 'DISPLAY_MIRROR_BUSY' });
    expect(f.peers).toHaveLength(0); expect(f.request.mock.calls.every(([action]) => action === 'open')).toBe(true);
    const attempts = f.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000); expect(f.request).toHaveBeenCalledTimes(attempts);
  });

  it.each(['EXHIBITION_CAMERA_BUSY', 'NETWORK_UNAVAILABLE'])('does not retry %s during an explicit release wait', async code => {
    const f = setup(); f.request.mockRejectedValue(new ApiError('连接未完成', code));
    await f.sender.start({ waitForRelease: true }); await vi.advanceTimersByTimeAsync(25000);
    expect(f.request).toHaveBeenCalledOnce(); expect(f.peers).toHaveLength(0);
    expect(f.change.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'error', error: '连接未完成', errorCode: code });
  });

  it('cancels a pending release wait when the source closes', async () => {
    const f = setup(); f.request.mockRejectedValue(new ApiError('正在停止', 'DISPLAY_MIRROR_BUSY'));
    const starting = f.sender.start({ waitForRelease: true }); await vi.advanceTimersByTimeAsync(0);
    f.sender.close(); await starting;
    const changes = f.change.mock.calls.length;
    await vi.advanceTimersByTimeAsync(25000);
    expect(f.request).toHaveBeenCalledOnce(); expect(f.change).toHaveBeenCalledTimes(changes); expect(f.peers).toHaveLength(0);
  });

  it('closes a host that opens after a retried connection has been disposed', async () => {
    const f = setup(); const opening = deferred<typeof session>();
    f.request.mockRejectedValueOnce(new ApiError('正在停止', 'DISPLAY_MIRROR_BUSY')).mockImplementationOnce(() => opening.promise);
    const starting = f.sender.start({ waitForRelease: true }); await vi.advanceTimersByTimeAsync(500);
    f.sender.close(); opening.resolve(session); await starting;
    expect(f.request.mock.calls.map(([action]) => action)).toEqual(['open', 'open', 'close']); expect(f.peers).toHaveLength(0);
  });

  it('preserves the selected mirror and same hostname on the HTTPS camera origin', () => {
    expect(defaultComputerCameraEntry('http://xuxin.local:10101/v1.1/exhibition/computer?mirror=a%2Fb#view'))
      .toBe('https://xuxin.local:10202/v1.1/exhibition/computer?mirror=a%2Fb#view');
    expect(defaultComputerCameraEntry('https://xuxin.local:10202/v1.1/exhibition/computer?mirror=a')).toBeNull();
    expect(defaultComputerCameraEntry('http://xuxin.local:10101/v1.1/exhibition/control')).toBeNull();
    const url = new URL(exhibitionComputerUrl('east/2', 'http://xuxin.local:10101/v1.1/exhibition/control'));
    expect(url.origin).toBe('https://xuxin.local:10202'); expect(url.pathname).toMatch(/\/exhibition\/computer$/);
    expect(url.searchParams.get('mirror')).toBe('east/2');
    expect(url.searchParams.has('output')).toBe(false);
    const browser = new URL(exhibitionComputerUrl('west', 'http://xuxin.local:10101/v1.1/exhibition/control', 'browser'));
    expect(browser.origin).toBe('https://xuxin.local:10202'); expect(browser.searchParams.get('mirror')).toBe('west');
    expect(browser.searchParams.get('output')).toBe('browser');
    expect(defaultComputerCameraEntry('http://xuxin.local:10101/v1.1/exhibition/computer?mirror=west&output=browser'))
      .toBe('https://xuxin.local:10202/v1.1/exhibition/computer?mirror=west&output=browser');
  });

  it('keeps a browser display delegated beyond receiver expiry without WebRTC or an Android receiver', async () => {
    const f = setup('browser'); f.offline(); const camera = track('camera');
    await f.sender.setSource(stream(camera), { source: 'camera', mirrored: true });
    await f.sender.setQuality('4k'); await f.sender.start();
    expect(f.request.mock.calls[0]).toEqual(['open', { deviceId: 'screen-unique', output: 'browser' }, expect.any(AbortSignal)]);
    await vi.advanceTimersByTimeAsync(45000);
    expect(f.change.mock.calls.at(-1)?.[0]).toMatchObject({ session, status: 'connected', receiverOnline: true, error: '' });
    expect(f.peers).toHaveLength(0); expect(f.receiverExpired).not.toHaveBeenCalled(); expect(f.stats).not.toHaveBeenCalled();
    expect(f.request.mock.calls.every(([action]) => ['open', 'poll'].includes(action))).toBe(true);
    f.sender.close();
    expect(f.request.mock.calls.at(-1)).toEqual(['close', { sessionId: session.sessionId, token: session.token }]);
    expect(camera.stop).not.toHaveBeenCalled();
  });

  it('still expires a browser display if backend delegation cannot be renewed', async () => {
    const f = setup('browser'); await f.sender.start();
    f.request.mockRejectedValue(new Error('offline'));
    await vi.advanceTimersByTimeAsync(19000);
    expect(f.change.mock.calls.at(-1)?.[0]).toMatchObject({ session: null, status: 'error', receiverOnline: false });
    expect(f.peers).toHaveLength(0); expect(f.receiverExpired).not.toHaveBeenCalled();
  });

  it('opens a delegated host and sends one H264-preferred video offer; ICE follows the accepted offer', async () => {
    const f = setup(); const camera = track('camera');
    await f.sender.setSource(stream(camera), { source: 'camera', mirrored: true });
    await f.sender.start();
    expect(f.request.mock.calls[0]).toEqual(['open', { deviceId: 'screen-unique' }, expect.any(AbortSignal)]);
    expect(f.peers).toHaveLength(1);
    expect(f.peers[0].addTransceiver).toHaveBeenCalledExactlyOnceWith(camera, { direction: 'sendonly', streams: [expect.any(Object)] });
    expect(f.peers[0].transceiver.setCodecPreferences.mock.calls[0][0].map((codec: any) => codec.mimeType)).toEqual(['video/H264', 'video/VP8', 'video/rtx']);
    const kinds = f.request.mock.calls.filter(([action]) => action === 'signal').map(([, body]) => body.kind);
    expect(kinds).toEqual(['offer', 'candidate', 'presentation']);
    expect(f.signals('presentation')).toEqual([{ epoch: 1, source: 'camera', mirrored: true }]);
    expect(f.peers[0].sender.setParameters).toHaveBeenCalledWith({ degradationPreference: 'maintain-framerate', encodings: [{ maxBitrate: 6_000_000, maxFramerate: 30, scaleResolutionDownBy: 1 }] });
    expect(f.request.mock.calls.every(([action]) => ['open', 'poll', 'signal'].includes(action))).toBe(true);
  });

  it('negotiates video without a camera for an image and later preserves the requested output mirroring', async () => {
    const f = setup(); await f.sender.start();
    expect(f.peers[0].addTransceiver).toHaveBeenCalledExactlyOnceWith('video', { direction: 'sendonly' });
    expect(f.signals('presentation')).toEqual([{ epoch: 1, source: 'image', mirrored: false }]);
    const generated = track('output', 1024, 1920);
    await f.sender.setSource(stream(generated), { source: 'output', mirrored: true });
    expect(f.peers).toHaveLength(1);
    expect(f.peers[0].sender.replaceTrack).toHaveBeenCalledExactlyOnceWith(generated);
    expect(f.signals('presentation').at(-1)).toEqual({ epoch: 1, source: 'output', mirrored: true });
    f.sender.close(); expect(generated.stop).not.toHaveBeenCalled();
  });

  it('keeps one sender across camera/output/camera switches and caps 4K encoding at 1080p', async () => {
    const f = setup(); const camera = track('camera', 3840, 2160); const output = track('output', 1080, 1920);
    await f.sender.setSource(stream(camera), { source: 'camera', mirrored: true }); await f.sender.start();
    expect(f.peers[0].sender.setParameters.mock.calls[0][0]).toMatchObject({ encodings: [{ scaleResolutionDownBy: 2 }] });
    await f.sender.setSource(stream(output), { source: 'output', mirrored: false });
    await f.sender.setSource(stream(camera), { source: 'camera', mirrored: false });
    expect(f.peers).toHaveLength(1); expect(f.signals('offer')).toHaveLength(1);
    expect(f.peers[0].sender.replaceTrack.mock.calls).toEqual([[output], [camera]]);
    expect(camera.stop).not.toHaveBeenCalled(); expect(output.stop).not.toHaveBeenCalled();
    await f.sender.setSource(null, { source: 'image', mirrored: true });
    expect(f.peers[0].sender.replaceTrack).toHaveBeenLastCalledWith(null);
    expect(f.signals('presentation').at(-1)).toEqual({ epoch: 1, source: 'image', mirrored: false });
  });

  it('updates output mirroring on the same borrowed track without renegotiating or rotating it', async () => {
    const f = setup(); const generated = track('cloud', 1024, 1920); const output = stream(generated);
    await f.sender.setSource(output, { source: 'output', mirrored: true, rotation: 270 }); await f.sender.start();
    await f.sender.setSource(output, { source: 'output', mirrored: false, rotation: 90 });
    await f.sender.setSource(output, { source: 'output', mirrored: true });
    expect(f.signals('presentation')).toEqual([
      { epoch: 1, source: 'output', mirrored: true }, { epoch: 1, source: 'output', mirrored: false }, { epoch: 1, source: 'output', mirrored: true },
    ]);
    expect(f.peers).toHaveLength(1); expect(f.signals('offer')).toHaveLength(1);
    expect(f.peers[0].sender.replaceTrack).not.toHaveBeenCalled(); expect(generated.stop).not.toHaveBeenCalled();
  });

  it.each([true, false])('retains output mirror=%s after receiver reconnect while keeping camera rotation out of the output', async mirrored => {
    const f = setup(); const camera = track('camera', 3840, 2160); const generated = track('cloud', 1024, 1920);
    await f.sender.setSource(stream(camera), { source: 'camera', mirrored, rotation: 270 }); await f.sender.start();
    await f.sender.setSource(stream(generated), { source: 'output', mirrored, rotation: 270 });
    expect(f.signals('presentation').at(-1)).toEqual({ epoch: 1, source: 'output', mirrored });
    f.advanceEpoch(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.peers).toHaveLength(2); expect(f.peers[1].sender.track).toBe(generated);
    expect(f.signals('presentation').at(-1)).toEqual({ epoch: 3, source: 'output', mirrored });
    await f.sender.setSource(stream(camera), { source: 'camera', mirrored, rotation: 270 });
    expect(f.signals('presentation').at(-1)).toEqual({ epoch: 3, source: 'camera', mirrored, rotation: 270 });
    expect(camera.stop).not.toHaveBeenCalled(); expect(generated.stop).not.toHaveBeenCalled();
  });

  it('clears inherited output mirroring and rotation when switching to page or image', async () => {
    const f = setup(); f.pageSupport(); const generated = track('cloud'); const page = track('page');
    await f.sender.setSource(stream(generated), { source: 'output', mirrored: true }); await f.sender.start();
    await f.sender.setSource(stream(page), { source: 'page', mirrored: true, rotation: 90 });
    expect(f.signals('presentation').at(-1)).toEqual({ epoch: 2, source: 'page', mirrored: false, active: true, presentationId: 1 });
    await f.sender.setSource(null, { source: 'image', mirrored: true, rotation: 270 });
    expect(f.signals('presentation').at(-1)).toEqual({ epoch: 2, source: 'image', mirrored: false });
    expect(f.peers[1].sender.track).toBeNull(); expect(generated.stop).not.toHaveBeenCalled(); expect(page.stop).not.toHaveBeenCalled();
  });

  it.each([[3840, 2160], [2160, 3840]])('preserves %d × %d in 4K mode at 24 Mbps and can return to 1080p on the same peer', async (width, height) => {
    const f = setup(); const camera = track('camera', width, height);
    await f.sender.setQuality('4k'); await f.sender.setSource(stream(camera), { source: 'camera', mirrored: true }); await f.sender.start();
    expect(f.peers[0].sender.setParameters).toHaveBeenLastCalledWith({ degradationPreference: 'maintain-resolution', encodings: [{ maxBitrate: 24_000_000, maxFramerate: 30, scaleResolutionDownBy: 1 }] });
    await f.sender.setQuality('1080p');
    expect(f.peers[0].sender.setParameters).toHaveBeenLastCalledWith({ degradationPreference: 'maintain-framerate', encodings: [{ maxBitrate: 6_000_000, maxFramerate: 30, scaleResolutionDownBy: 2 }] });
    expect(f.peers).toHaveLength(1); expect(camera.stop).not.toHaveBeenCalled();
  });

  it.each([[1280, 720, 1], [1920, 1080, 1], [7680, 4320, 2]])('never upscales %d × %d and limits oversized input in 4K mode', async (width, height, scale) => {
    const f = setup(); await f.sender.setQuality('4k');
    await f.sender.setSource(stream(track('camera', width, height)), { source: 'camera', mirrored: false }); await f.sender.start();
    expect(f.peers[0].sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [{ maxBitrate: 24_000_000, maxFramerate: 30, scaleResolutionDownBy: scale }] }));
  });

  it('signals raw camera rotation, resets it for cloud output and restores it after receiver reconnect', async () => {
    const f = setup(); const camera = track('camera', 3840, 2160);
    await f.sender.setQuality('4k'); await f.sender.setSource(stream(camera), { source: 'camera', mirrored: true, rotation: 270 }); await f.sender.start();
    expect(f.signals('presentation').at(-1)).toEqual({ epoch: 1, source: 'camera', mirrored: true, rotation: 270 });
    await f.sender.setSource(stream(track('cloud', 1024, 1920)), { source: 'output', mirrored: true, rotation: 270 });
    expect(f.signals('presentation').at(-1)).toEqual({ epoch: 1, source: 'output', mirrored: true });
    await f.sender.setSource(stream(camera), { source: 'camera', mirrored: true, rotation: 90 });
    f.advanceEpoch(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.signals('presentation').at(-1)).toEqual({ epoch: 3, source: 'camera', mirrored: true, rotation: 90 });
    expect(f.peers[1].sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [{ maxBitrate: 24_000_000, maxFramerate: 30, scaleResolutionDownBy: 1 }] }));
    expect(camera.stop).not.toHaveBeenCalled();
  });

  it('does not publish a newer rotation while an older track replacement is still completing', async () => {
    const f = setup(); await f.sender.start();
    const first = deferred<void>(); const second = deferred<void>(); const peer = f.peers[0];
    peer.sender.replaceTrack.mockImplementationOnce(async value => { await first.promise; peer.sender.track = value; })
      .mockImplementationOnce(async value => { await second.promise; peer.sender.track = value; });
    const stale = f.sender.setSource(stream(track('old-portrait')), { source: 'camera', mirrored: true });
    await Promise.resolve();
    const latest = f.sender.setSource(stream(track('raw-landscape', 3840, 2160)), { source: 'camera', mirrored: true, rotation: 270 });
    first.resolve();
    for (let count = 0; count < 12; count++) await Promise.resolve();
    expect(f.signals('presentation')).toEqual([{ epoch: 1, source: 'image', mirrored: false }]);
    second.resolve(); await Promise.all([stale, latest]);
    expect(peer.sender.track?.id).toBe('raw-landscape');
    expect(f.signals('presentation').at(-1)).toEqual({ epoch: 1, source: 'camera', mirrored: true, rotation: 270 });
  });

  it('does not publish changed metadata against the old track captured by an in-flight offer', async () => {
    const f = setup(); const accepted = deferred<void>(); const original = f.request.getMockImplementation()!;
    const publications: { track: string | undefined; payload: unknown }[] = [];
    f.request.mockImplementation(async (action, body) => {
      if (action === 'signal' && body.kind === 'offer') await accepted.promise;
      if (action === 'signal' && body.kind === 'presentation') publications.push({ track: f.peers[0].sender.track?.id, payload: body.payload });
      return original(action, body);
    });
    await f.sender.setSource(stream(track('raw-camera', 3840, 2160)), { source: 'camera', mirrored: true, rotation: 270 });
    const starting = f.sender.start();
    for (let count = 0; count < 12; count++) await Promise.resolve();
    const changing = f.sender.setSource(stream(track('cloud-output', 1024, 1920)), { source: 'output', mirrored: false });
    accepted.resolve(); await Promise.all([starting, changing]);
    expect(publications).toEqual([{ track: 'cloud-output', payload: { epoch: 1, source: 'output', mirrored: false } }]);
  });

  it('buffers candidates until the matching answer and rejects old epochs', async () => {
    const f = setup(); await f.sender.start();
    f.push({ kind: 'candidate', payload: { epoch: 1, candidate: 'remote', sdpMid: '0', sdpMLineIndex: 0 } });
    f.push({ kind: 'candidate', payload: { epoch: 0, candidate: 'old', sdpMid: '0', sdpMLineIndex: 0 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.peers[0].addIceCandidate).not.toHaveBeenCalled();
    f.push({ kind: 'answer', payload: { epoch: 0, type: 'answer', sdp: 'old-answer' } });
    f.push({ kind: 'answer', payload: { epoch: 1, type: 'answer', sdp: 'answer' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.peers[0].setRemoteDescription).toHaveBeenCalledExactlyOnceWith({ type: 'answer', sdp: 'answer' });
    expect(f.peers[0].addIceCandidate).toHaveBeenCalledExactlyOnceWith({ candidate: 'remote', sdpMid: '0', sdpMLineIndex: 0 });
  });

  it('uses the new receiver epoch and re-publishes unchanged presentation after reconnect', async () => {
    const f = setup(); await f.sender.setSource(stream(track('camera')), { source: 'camera', mirrored: true }); await f.sender.start();
    const old = f.peers[0]; f.advanceEpoch(); await vi.advanceTimersByTimeAsync(1000);
    expect(old.close).toHaveBeenCalledOnce(); expect(f.peers).toHaveLength(2);
    expect(f.signals('offer').map(value => value.epoch)).toEqual([1, 3]);
    expect(f.signals('presentation')).toEqual([{ epoch: 1, source: 'camera', mirrored: true }, { epoch: 3, source: 'camera', mirrored: true }]);
    old.candidate('late'); expect(f.signals('candidate')).toHaveLength(2);
  });

  it('renegotiates after a hardware encoder rejects a replacement track', async () => {
    const f = setup(); await f.sender.start();
    f.peers[0].sender.replaceTrack.mockRejectedValueOnce(new Error('InvalidModificationError'));
    const output = track('output'); await f.sender.setSource(stream(output), { source: 'output', mirrored: false });
    expect(f.peers).toHaveLength(2); expect(f.peers[1].sender.track).toBe(output);
    expect(f.signals('offer').map(value => value.epoch)).toEqual([1, 2]);
  });

  it('closes a late host open after disposal without polling or creating a peer', async () => {
    const f = setup(); const opening = deferred<typeof session>(); f.request.mockImplementationOnce(() => opening.promise);
    const pending = f.sender.start(); f.sender.close(); opening.resolve(session); await pending;
    expect(f.request.mock.calls.map(([action]) => action)).toEqual(['open', 'close']); expect(f.peers).toHaveLength(0);
  });

  it('expires the host locally before a lost poll can outlive its server lease', async () => {
    const f = setup(); await f.sender.start();
    f.request.mockRejectedValue(new Error('offline'));
    await vi.advanceTimersByTimeAsync(19000);
    expect(f.change.mock.calls.at(-1)?.[0]).toMatchObject({ session: null, status: 'error', receiverOnline: false });
    expect(f.peers[0].close).toHaveBeenCalledOnce();
  });

  it('stops as soon as the server reports its receiver lease expired, then resumes transport without generation commands', async () => {
    const f = setup(); await f.sender.start(); f.offline();
    await vi.advanceTimersByTimeAsync(1000); expect(f.receiverExpired).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000); expect(f.receiverExpired).toHaveBeenCalledOnce();
    f.online(); f.advanceEpoch(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.peers).toHaveLength(2);
    expect(f.request.mock.calls.every(([action]) => ['open', 'poll', 'signal'].includes(action))).toBe(true);
  });

  it('expires a source that has never found a receiver after 20 seconds', async () => {
    const f = setup(); f.offline(); await f.sender.start();
    await vi.advanceTimersByTimeAsync(19000); expect(f.receiverExpired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); expect(f.receiverExpired).toHaveBeenCalledOnce();
  });

  it('resynchronizes the server epoch when an offer fails before acceptance', async () => {
    const f = setup(); const original = f.request.getMockImplementation()!;
    let first = true;
    f.request.mockImplementation(async (action, body) => {
      if (first && action === 'signal' && body.kind === 'offer') { first = false; throw new Error('connection lost before acceptance'); }
      return original(action, body);
    });
    await f.sender.start(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.signals('offer').map(value => value.epoch)).toEqual([1, 1]);
    expect(f.signals('presentation')).toHaveLength(1);
  });

  it('revokes the local delegation immediately on server authentication failure', async () => {
    const f = setup(); await f.sender.start();
    f.request.mockRejectedValue(Object.assign(new Error('expired'), { code: 'DISPLAY_UNAUTHORIZED' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.change.mock.calls.at(-1)?.[0]).toMatchObject({ session: null, status: 'error' });
  });

  it('reports outbound frame and bitrate stats without affecting media ownership', async () => {
    const f = setup(); await f.sender.start();
    const stats = (timestamp: number, bytes: number, frames: number) => new Map([
      ['out', { type: 'outbound-rtp', kind: 'video', timestamp, bytesSent: bytes, framesEncoded: frames, frameWidth: 1920, frameHeight: 1080, codecId: 'codec' }],
      ['codec', { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' }],
    ]);
    f.peers[0].getStats.mockResolvedValueOnce(stats(1000, 1000, 30)).mockResolvedValueOnce(stats(2000, 751000, 60));
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.stats.mock.calls.at(-1)?.[0]).toEqual({ framesPerSecond: 30, width: 1920, height: 1080, bitrate: 6_000_000, codec: 'video/H264',
      codecFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' });
  });

  it('joins source, selected network path and matching remote receiver stats with interval encoding cost', async () => {
    const f = setup(); await f.sender.start();
    const report = (timestamp: number, frames: number, totalEncodeTime: number) => new Map<string, any>([
      ['out', { id: 'out', type: 'outbound-rtp', kind: 'video', timestamp, bytesSent: timestamp * 3000, framesEncoded: frames,
        frameWidth: 3840, frameHeight: 2160, framesPerSecond: 4, totalEncodeTime, mediaSourceId: 'source', transportId: 'transport',
        qualityLimitationReason: 'cpu', encoderImplementation: 'VideoToolbox', powerEfficientEncoder: true }],
      ['other-source', { type: 'media-source', kind: 'video', width: 640, height: 480, framesPerSecond: 10 }],
      ['source', { type: 'media-source', kind: 'video', width: 3840, height: 2160, framesPerSecond: 30 }],
      ['transport', { type: 'transport', selectedCandidatePairId: 'selected' }],
      ['other-pair', { type: 'candidate-pair', availableOutgoingBitrate: 100_000_000 }],
      ['selected', { type: 'candidate-pair', availableOutgoingBitrate: 25_000_000 }],
      ['other-remote', { type: 'remote-inbound-rtp', localId: 'audio-out', fractionLost: 0.9, roundTripTime: 2 }],
      ['remote', { type: 'remote-inbound-rtp', localId: 'out', fractionLost: 0.02, roundTripTime: 0.008 }],
    ]);
    f.peers[0].getStats.mockResolvedValueOnce(report(1000, 10, 1)).mockResolvedValueOnce(report(2000, 14, 1.5));
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.stats.mock.calls.at(-1)?.[0].encodeMsPerFrame).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.stats.mock.calls.at(-1)?.[0]).toMatchObject({
      sourceWidth: 3840, sourceHeight: 2160, sourceFps: 30, qualityLimitationReason: 'cpu', encodeMsPerFrame: 125,
      availableOutgoingBitrate: 25_000_000, encoderImplementation: 'VideoToolbox', powerEfficientEncoder: true,
      fractionLost: 0.02, roundTripTime: 0.008,
    });
  });

  it('leaves unavailable diagnostics undefined and keeps meaningful zero and false values', async () => {
    const f = setup(); await f.sender.start();
    f.peers[0].getStats.mockResolvedValueOnce(new Map<string, any>([
      ['out', { id: 'out', type: 'outbound-rtp', kind: 'video', timestamp: 1000, bytesSent: 0, framesEncoded: 0,
        mediaSourceId: 'missing', transportId: 'missing', powerEfficientEncoder: false }],
      ['unselected', { type: 'candidate-pair', availableOutgoingBitrate: 50_000_000 }],
      ['remote', { type: 'remote-inbound-rtp', localId: 'out', fractionLost: 0, roundTripTime: 0 }],
    ]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.stats.mock.calls.at(-1)?.[0]).toMatchObject({
      sourceWidth: undefined, sourceHeight: undefined, sourceFps: undefined, qualityLimitationReason: undefined,
      codecFmtpLine: undefined,
      encodeMsPerFrame: undefined, availableOutgoingBitrate: undefined, encoderImplementation: undefined,
      powerEfficientEncoder: false, fractionLost: 0, roundTripTime: 0,
    });
  });

  it.each(['no-frames', 'reset', 'missing', 'non-finite'] as const)('does not invent encoder cost for %s samples', async mode => {
    const f = setup(); await f.sender.start();
    const report = (timestamp: number, framesEncoded: number, totalEncodeTime: unknown) => new Map<string, any>([
      ['out', { type: 'outbound-rtp', kind: 'video', timestamp, bytesSent: 0, framesEncoded, totalEncodeTime }],
    ]);
    f.peers[0].getStats.mockResolvedValueOnce(report(1000, 30, 1))
      .mockResolvedValueOnce(report(2000, mode === 'no-frames' ? 30 : mode === 'reset' ? 5 : 60,
        mode === 'missing' ? undefined : mode === 'non-finite' ? NaN : mode === 'reset' ? 0.2 : 1.2));
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.stats.mock.calls.at(-1)?.[0].encodeMsPerFrame).toBeUndefined();
  });
});
