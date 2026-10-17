import { api, ApiError } from '../api';
import { exhibitionApiPath, exhibitionUrl } from './mirrorApi';
import type { ComputerDisplayHostSession, ComputerDisplayHostPoll, ComputerDisplaySignal, ComputerDisplaySource } from '../../shared/computerDisplay';
import { computerDisplayFrameRate, computerDisplayProfile, computerDisplayQuality, type ComputerDisplayFrameRate, type ComputerDisplayQuality } from './cameraQuality';

export type ComputerDisplaySession = ComputerDisplayHostSession;
export type { ComputerDisplaySignal, ComputerDisplaySource } from '../../shared/computerDisplay';
export type ComputerDisplayOutput = 'android' | 'browser';
export interface ComputerDisplayPresentation { source: ComputerDisplaySource; mirrored: boolean; rotation?: 0 | 90 | 180 | 270; active?: boolean; presentationId?: number }
export type ComputerDisplayPoll = ComputerDisplayHostPoll;
export interface ComputerDisplayStats {
  framesPerSecond: number; width: number; height: number; bitrate: number; codec: string; codecFmtpLine?: string;
  sourceWidth?: number; sourceHeight?: number; sourceFps?: number;
  qualityLimitationReason?: string; encodeMsPerFrame?: number; availableOutgoingBitrate?: number;
  encoderImplementation?: string; powerEfficientEncoder?: boolean;
  fractionLost?: number; roundTripTime?: number;
}
export interface ComputerDisplayState {
  session: ComputerDisplaySession | null;
  status: 'opening' | 'releasing' | 'waiting' | 'connecting' | 'connected' | 'error' | 'closed';
  receiverOnline: boolean; error: string; errorCode?: string;
  receiverSupportsPage?: boolean;
  receiverSupportsPageAck?: boolean;
  receiverRenderedPage?: boolean;
}
interface DisplayDependencies {
  request<T>(action: string, body: unknown, signal?: AbortSignal): Promise<T>;
  peer(): RTCPeerConnection;
  codecs(): RTCRtpCodec[];
  now(): number;
}
interface DisplayEvents {
  change(state: ComputerDisplayState): void;
  receiverExpired?(): void;
  connectionLost?(): void;
  stats?(stats: ComputerDisplayStats): void;
  qualityError?(message: string): void;
}

const OUTPUT_SETTINGS_ERROR = '输出设置未生效，请重试。';
interface OutputSettings { quality: ComputerDisplayQuality; frameRate: ComputerDisplayFrameRate }

function nonNegativeStat(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function exhibitionComputerUrl(mirrorId = 'default', href = typeof window === 'undefined' ? 'http://xuminghong.local:10200/' : window.location.href, output: ComputerDisplayOutput = 'android') {
  const url = new URL(exhibitionUrl('/exhibition/computer', mirrorId), href);
  url.protocol = 'https:'; url.port = '10202';
  if (output === 'browser') url.searchParams.set('output', output);
  return url.toString();
}

export function exhibitionHdmiUrl(mirrorId = 'default', href?: string) {
  const url = new URL(exhibitionComputerUrl(mirrorId, href, 'browser'));
  url.searchParams.set('presentation', 'hdmi');
  return url.toString();
}

export function exhibitionWirelessUrl(mirrorId = 'default', href?: string) {
  const url = new URL(exhibitionComputerUrl(mirrorId, href));
  url.searchParams.set('presentation', 'wireless');
  return url.toString();
}

export function defaultComputerCameraEntry(href: string): string | null {
  const url = new URL(href);
  if (!/^\/v1\.1\/exhibition\/computer\/?$/.test(url.pathname) || (url.protocol === 'https:' && url.port === '10202')) return null;
  url.protocol = 'https:'; url.port = '10202';
  return url.toString();
}

/** Borrowed camera/output tracks belong to useExhibitionLive, never to this transport. */
export class ComputerDisplaySender {
  private readonly deps: DisplayDependencies;
  private state: ComputerDisplayState = { session: null, status: 'opening', receiverOnline: false, receiverRenderedPage: false, error: '' };
  private disposed = false;
  private started = false;
  private requests = new Set<AbortController>();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private leaseTimer?: ReturnType<typeof setTimeout>;
  private receiverTimer?: ReturnType<typeof setTimeout>;
  private releaseWait?: { timer: ReturnType<typeof setTimeout>; finish(): void };
  private peerConnection: RTCPeerConnection | null = null;
  private sender: RTCRtpSender | null = null;
  private stream: MediaStream | null = null;
  private outputSettings: OutputSettings = { quality: '1080p', frameRate: 30 };
  private acceptedOutputSettings: OutputSettings = this.outputSettings;
  private qualityRevision = 0;
  private qualityFailureRevision?: number;
  private sourceRevision = 0;
  private pagePresentationId = 0;
  private pageTrack: MediaStreamTrack | null = null;
  private expectedRendered: { epoch: number; presentationId: number; accepted: boolean; rendered: boolean } | null = null;
  private presentation: ComputerDisplayPresentation = { source: 'image', mirrored: false };
  private publishedPresentation = '';
  private cursor = 0;
  private epoch = 0;
  private offerSent = false;
  private localCandidates: Extract<ComputerDisplaySignal, { kind: 'candidate' }>['payload'][] = [];
  private remoteCandidates: RTCIceCandidateInit[] = [];
  private operations = Promise.resolve();
  private previousStats?: { timestamp: number; bytes: number; frames: number; totalEncodeTime?: number };
  private receiverExpired = false;
  private disconnectedAt?: number;
  private peerInterrupted = false;

  constructor(mirrorId: string, private deviceId: string, private events: DisplayEvents, dependencies: Partial<DisplayDependencies> = {}, private output: ComputerDisplayOutput = 'android') {
    this.deps = {
      request: (action, body, signal) => api(exhibitionApiPath(`display/host/${action}`, mirrorId), 'POST', body, signal, action === 'close'),
      peer: () => new RTCPeerConnection({ iceServers: [] }),
      codecs: () => RTCRtpSender.getCapabilities?.('video')?.codecs ?? [],
      now: () => performance.now(),
      ...dependencies,
    };
  }

  private update(patch: Partial<ComputerDisplayState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch }; this.events.change({ ...this.state });
  }

  private async request<T>(action: string, body: unknown): Promise<T> {
    const controller = new AbortController(); this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 6000);
    try { return await this.deps.request<T>(action, body, controller.signal); }
    finally { clearTimeout(timeout); this.requests.delete(controller); }
  }

  private authenticated<T>(action: string, body: object = {}) {
    const session = this.state.session;
    if (!session || this.disposed) return Promise.reject(new Error('电脑视频源已关闭。'));
    return this.request<T>(action, { sessionId: session.sessionId, token: session.token, ...body });
  }

  private waitForRelease(delay: number): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(wait.timer);
        if (this.releaseWait === wait) this.releaseWait = undefined;
        resolve();
      };
      const wait = { timer: setTimeout(finish, delay), finish };
      this.releaseWait = wait;
    });
  }

  private async openHost(waitForRelease: boolean, replaceHost: boolean) {
    const deadline = this.deps.now() + 20000;
    while (!this.disposed) {
      try {
        return await this.request<ComputerDisplaySession>('open', { deviceId: this.deviceId, ...(this.output === 'browser' ? { output: 'browser' } : {}), ...(replaceHost ? { replaceHost: true } : {}) });
      } catch (cause) {
        if (this.disposed) return null;
        if (!waitForRelease || !(cause instanceof ApiError) || cause.code !== 'DISPLAY_MIRROR_BUSY') throw cause;
        const remaining = deadline - this.deps.now();
        if (remaining <= 0) throw new ApiError('停止状态未确认，请重试。', cause.code);
        this.update({ status: 'releasing', error: '', errorCode: undefined });
        await this.waitForRelease(Math.min(500, remaining));
      }
    }
    return null;
  }

  async start(options: { waitForRelease?: boolean; replaceHost?: boolean } = {}) {
    if (this.started || this.disposed) return;
    this.started = true;
    this.update({ status: 'opening', error: '', errorCode: undefined });
    try {
      const session = await this.openHost(options.waitForRelease === true, options.replaceHost === true);
      if (!session) return;
      if (this.disposed) { void this.deps.request('close', { sessionId: session.sessionId, token: session.token }).catch(() => undefined); return; }
      this.update({ session, status: this.output === 'browser' ? 'connected' : 'waiting', receiverOnline: this.output === 'browser' });
      this.renewLease();
      if (this.output === 'android') this.watchReceiver();
      await this.poll();
    } catch (cause) {
      if (!this.disposed) this.update({ status: 'error', error: cause instanceof Error ? cause.message : '电脑视频源连接失败。',
        errorCode: cause instanceof ApiError ? cause.code : undefined });
    }
  }

  private renewLease() {
    clearTimeout(this.leaseTimer);
    // Stop local generation before the server's 20 second delegation expires.
    this.leaseTimer = setTimeout(() => this.expire('电脑与后台连接中断。'), 19000);
  }

  private watchReceiver() {
    clearTimeout(this.receiverTimer);
    if (this.state.receiverOnline) { this.receiverExpired = false; return; }
    this.receiverTimer = setTimeout(() => {
      if (this.disposed || this.state.receiverOnline || this.receiverExpired) return;
      this.expireReceiver();
    }, 20000);
  }

  private expireReceiver() {
    if (this.disposed || this.receiverExpired) return;
    this.receiverExpired = true; clearTimeout(this.receiverTimer); this.events.receiverExpired?.();
  }

  private expire(message: string) {
    if (this.disposed) return;
    const session = this.state.session;
    clearTimeout(this.pollTimer); clearTimeout(this.leaseTimer); clearTimeout(this.receiverTimer);
    this.closePeer();
    this.update({ session: null, status: 'error', receiverOnline: false, receiverSupportsPage: false, receiverSupportsPageAck: false, error: message });
    this.requests.forEach(request => request.abort());
    if (session) void this.deps.request('close', { sessionId: session.sessionId, token: session.token }).catch(() => undefined);
  }

  private async poll() {
    if (this.disposed || !this.state.session) return;
    try {
      const result = await this.authenticated<ComputerDisplayPoll>('poll', { after: this.cursor });
      if (this.disposed || !this.state.session) return;
      this.renewLease();
      this.cursor = Math.max(this.cursor, result.cursor);
      if (this.output === 'browser') {
        this.update({ receiverOnline: true, status: 'connected', error: '' });
        return;
      }
      const changed = result.receiverOnline !== this.state.receiverOnline;
      const receiverSupportsPage = result.receiverOnline && result.receiverCapabilities?.includes('page') === true;
      const receiverSupportsPageAck = result.receiverOnline && result.receiverCapabilities?.includes('page-rendered') === true;
      const pageSupportChanged = receiverSupportsPage !== (this.state.receiverSupportsPage === true);
      if (!receiverSupportsPageAck) this.clearRenderedPage();
      this.update({ receiverOnline: result.receiverOnline, receiverSupportsPage, receiverSupportsPageAck, error: '' });
      if (changed) {
        // The server reports offline only after the receiver's own 20 second lease.
        if (!result.receiverOnline) this.expireReceiver();
        else this.watchReceiver();
      }
      await this.enqueue(async () => {
        if (pageSupportChanged && this.presentation.source === 'page') this.closePeer();
        // A rejected/lost offer may not have advanced the server epoch. A live
        // peer may meanwhile have accepted an offer after this poll was sent.
        if (!this.peerConnection || result.epoch > this.epoch) this.epoch = result.epoch;
        if (!result.receiverOnline) { this.closePeer(); this.update({ status: 'waiting' }); return; }
        for (const message of result.messages) await this.receive(message);
        if (!this.peerConnection) await this.offer();
        if (this.disconnectedAt !== undefined && this.deps.now() - this.disconnectedAt > 5000) {
          this.closePeer(); await this.offer();
        }
      }).catch(() => { this.reportConnectionLost(); this.closePeer(); this.update({ status: 'connecting', error: '视频连接正在重试…' }); });
      await this.collectStats();
    } catch (cause) {
      if (!this.disposed && this.state.session) {
        const code = (cause as { code?: string })?.code ?? '';
        if (/DISPLAY_.*(EXPIRED|INVALID|MISMATCH|CLOSED|NOT_FOUND|UNAUTHORIZED)/.test(code)) this.expire('电脑视频源身份已失效。');
        else this.update({ error: '视频连接正在重试…' });
      }
    } finally {
      if (!this.disposed && this.state.session) this.pollTimer = setTimeout(() => void this.poll(), 1000);
    }
  }

  private enqueue(operation: () => Promise<void>) {
    const result = this.operations.then(async () => { if (!this.disposed && this.state.session) await operation(); });
    this.operations = result.catch(() => undefined);
    return result;
  }

  private signal(signal: ComputerDisplaySignal) { return this.authenticated('signal', signal); }

  private current(peer: RTCPeerConnection, epoch: number) {
    return !this.disposed && !!this.state.session && this.peerConnection === peer && this.epoch === epoch;
  }

  private async offer() {
    if (!this.state.receiverOnline || this.disposed || !this.state.session) return;
    this.closePeer();
    const peer = this.deps.peer(); this.peerConnection = peer;
    const epoch = ++this.epoch;
    this.update({ status: 'connecting' });
    peer.onicecandidate = event => {
      if (!event.candidate || !this.current(peer, epoch)) return;
      const candidate = event.candidate.toJSON();
      if (!candidate.candidate) return;
      this.localCandidates.push({ epoch, candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null, usernameFragment: candidate.usernameFragment ?? null });
      if (this.offerSent) void this.enqueue(() => this.flushCandidates(peer, epoch)).catch(() => this.retryPeer(peer));
    };
    peer.onconnectionstatechange = () => {
      if (!this.current(peer, epoch)) return;
      if (peer.connectionState === 'connected') {
        this.disconnectedAt = undefined; this.peerInterrupted = false; this.update({ status: 'connected', error: '' });
      } else if (peer.connectionState === 'failed') this.retryPeer(peer);
      else if (peer.connectionState === 'disconnected') {
        this.reportConnectionLost();
        this.disconnectedAt ??= this.deps.now(); this.update({ status: 'connecting' });
      }
    };
    const sourceRevision = this.sourceRevision;
    const presentation = this.presentation;
    const track = this.sourceTrack();
    const transceiver = peer.addTransceiver(track ?? 'video', { direction: 'sendonly', ...(track && this.stream ? { streams: [this.stream] } : {}) });
    this.sender = transceiver.sender;
    const codecs = this.deps.codecs();
    if (codecs.some(codec => codec.mimeType.toLowerCase() === 'video/h264')) {
      // Keep fallback codecs and their repair codecs available for browser compatibility.
      try { transceiver.setCodecPreferences([...codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/h264'), ...codecs.filter(codec => codec.mimeType.toLowerCase() !== 'video/h264')]); } catch { /* Older Chromium uses its supported default order. */ }
    }
    try {
      const offer = await peer.createOffer();
      if (!this.current(peer, epoch)) return;
      await peer.setLocalDescription(offer);
      if (!this.current(peer, epoch)) return;
      await this.signal({ kind: 'offer', payload: { epoch, type: 'offer', sdp: peer.localDescription?.sdp ?? offer.sdp ?? '' } });
      if (!this.current(peer, epoch)) return;
      this.offerSent = true;
      // Rejected encoder preferences must not tear down a usable video connection.
      await this.configureSender().catch(() => undefined);
      await this.flushCandidates(peer, epoch);
      if (sourceRevision === this.sourceRevision) await this.publishPresentation(presentation);
    } catch (cause) { if (this.current(peer, epoch)) this.closePeer(); throw cause; }
  }

  private retryPeer(peer: RTCPeerConnection) {
    if (this.peerConnection !== peer || this.disposed) return;
    this.reportConnectionLost();
    this.closePeer(); this.update({ status: 'connecting' });
  }

  private reportConnectionLost() {
    if (!this.peerConnection || this.peerInterrupted || this.disposed) return;
    this.peerInterrupted = true;
    this.clearRenderedPage();
    this.events.connectionLost?.();
  }

  private async flushCandidates(peer: RTCPeerConnection, epoch: number) {
    while (this.current(peer, epoch) && this.offerSent && this.localCandidates.length) {
      const candidate = this.localCandidates.shift()!;
      await this.signal({ kind: 'candidate', payload: candidate });
    }
  }

  private async receive(message: ComputerDisplaySignal) {
    if (message.kind === 'ready' || message.kind === 'reset') {
      if (message.payload.epoch < this.epoch) return;
      // Receiver restarts/reset invalidate the old video even if its ICE event is delayed.
      this.reportConnectionLost();
      this.epoch = message.payload.epoch; this.closePeer(); return;
    }
    if (message.payload.epoch !== this.epoch || !this.peerConnection) return;
    if (message.kind === 'rendered') {
      if (this.state.receiverSupportsPageAck && this.presentation.source === 'page' && this.presentation.active && this.sourceTrack()
        && this.presentation.presentationId === message.payload.presentationId && this.expectedRendered?.epoch === message.payload.epoch
        && this.expectedRendered.presentationId === message.payload.presentationId) {
        this.expectedRendered.rendered = true;
        if (this.expectedRendered.accepted) this.update({ receiverRenderedPage: true });
      }
      return;
    }
    const peer = this.peerConnection;
    if (message.kind === 'answer') {
      if (peer.signalingState !== 'have-local-offer') return;
      await peer.setRemoteDescription({ type: 'answer', sdp: message.payload.sdp });
      if (!this.current(peer, message.payload.epoch)) return;
      for (const candidate of this.remoteCandidates.splice(0)) await peer.addIceCandidate(candidate);
    } else if (message.kind === 'candidate') {
      const { epoch: _epoch, ...candidate } = message.payload;
      if (!peer.remoteDescription) this.remoteCandidates.push(candidate);
      else await peer.addIceCandidate(candidate);
    }
  }

  /** Change the single video sender without cloning or stopping the source tracks. */
  setSource(stream: MediaStream | null, presentation: ComputerDisplayPresentation) {
    if (this.output === 'browser') return Promise.resolve();
    const revision = ++this.sourceRevision;
    const track = stream?.getVideoTracks().find(item => item.readyState === 'live') ?? null;
    const pageChanged = presentation.source === 'page' && (this.presentation.source !== 'page' || this.stream !== stream || this.pageTrack !== track);
    const pageCaptureChanged = pageChanged && track !== null;
    if (pageChanged) ++this.pagePresentationId;
    if (pageChanged || presentation.source !== 'page') this.clearRenderedPage();
    this.pageTrack = presentation.source === 'page' ? track : null;
    this.stream = stream;
    const rotation = presentation.source === 'camera' && [90, 180, 270].includes(presentation.rotation ?? 0) ? presentation.rotation : 0;
    this.presentation = { source: presentation.source, mirrored: (presentation.source === 'camera' || presentation.source === 'output') && presentation.mirrored,
      ...(rotation ? { rotation } : {}),
      ...(presentation.source === 'page' ? { active: !!track, presentationId: this.pagePresentationId } : {}) };
    const nextPresentation = this.presentation;
    return this.enqueue(async () => {
      if (revision !== this.sourceRevision) return;
      const sender = this.sender;
      if (!sender || !this.peerConnection) return;
      // A fresh peer fences old RTP frames from a previous capture batch, so its
      // rendered acknowledgement cannot mistakenly confirm the new page.
      if (pageCaptureChanged) { this.closePeer(); await this.offer(); return; }
      const track = this.sourceTrack();
      try {
        if (sender.track !== track) await sender.replaceTrack(track);
        if (revision !== this.sourceRevision) return;
        await this.configureSender().catch(() => undefined);
        if (revision === this.sourceRevision) await this.publishPresentation(nextPresentation);
      } catch {
        if (revision !== this.sourceRevision) return;
        // Some hardware encoders require a fresh negotiation for a different output size.
        this.closePeer(); await this.offer();
      }
    });
  }

  private sourceTrack(): MediaStreamTrack | null {
    // Old Android receivers lay native controls over video; never send a page to them.
    if (this.presentation.source === 'page' && this.state.receiverSupportsPage !== true) return null;
    return this.stream?.getVideoTracks().find(item => item.readyState === 'live') ?? null;
  }

  setQuality(quality: ComputerDisplayQuality, frameRate: ComputerDisplayFrameRate = 30) {
    if (this.output === 'browser') return Promise.resolve();
    const revision = ++this.qualityRevision;
    // Persist the request even before a session or a video track is available.
    this.outputSettings = { quality: computerDisplayQuality(quality), frameRate: computerDisplayFrameRate(frameRate) };
    return this.enqueue(async () => { if (revision === this.qualityRevision) await this.configureSender(); });
  }

  private async configureSender() {
    const sender = this.sender;
    if (!sender?.track) return;
    const settings = this.outputSettings;
    const revision = this.qualityRevision;
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) throw new Error('Video encoding controls are unavailable.');
      const { width = 1920, height = 1080 } = sender.track.getSettings();
      const profile = computerDisplayProfile(settings.quality);
      for (const encoding of parameters.encodings) {
        encoding.maxBitrate = profile.maxBitrate; encoding.maxFramerate = settings.frameRate;
        encoding.scaleResolutionDownBy = Math.max(1, Math.max(width, height) / profile.width, Math.min(width, height) / profile.height);
      }
      parameters.degradationPreference = this.presentation.source === 'page' || settings.quality === '2k' || settings.quality === '4k' ? 'maintain-resolution' : 'maintain-framerate';
      await sender.setParameters(parameters);
      if (this.disposed || sender !== this.sender) return;
      this.acceptedOutputSettings = settings;
      if (revision === this.qualityRevision && revision !== this.qualityFailureRevision) this.events.qualityError?.('');
    } catch (cause) {
      if (!this.disposed && sender === this.sender && revision === this.qualityRevision) {
        this.outputSettings = this.acceptedOutputSettings;
        this.qualityFailureRevision = revision;
        this.events.qualityError?.(OUTPUT_SETTINGS_ERROR);
      }
      throw new Error(OUTPUT_SETTINGS_ERROR, { cause });
    }
  }

  private async publishPresentation(presentation: ComputerDisplayPresentation) {
    if (!this.offerSent) return;
    if (presentation.source === 'page') {
      if (this.state.receiverSupportsPage !== true) return;
      presentation = { ...presentation, active: !!this.sourceTrack() };
    }
    const peer = this.peerConnection;
    const epoch = this.epoch;
    const key = JSON.stringify({ epoch, ...presentation });
    if (key === this.publishedPresentation) return;
    const expected = presentation.source === 'page' && presentation.active && this.presentation.source === 'page'
      && this.presentation.presentationId === presentation.presentationId && this.sourceTrack()
      ? { epoch, presentationId: presentation.presentationId!, accepted: false, rendered: false } : null;
    // Android may report its first frame before the publication's HTTP response
    // arrives. Keep that ACK pending until this exact publication is accepted.
    if (expected) this.expectedRendered = expected;
    try { await this.signal({ kind: 'presentation', payload: { epoch, ...presentation } }); }
    catch (cause) {
      if (expected && this.expectedRendered === expected) this.clearRenderedPage();
      throw cause;
    }
    if (!peer || !this.current(peer, epoch)) return;
    this.publishedPresentation = key;
    if (expected && this.expectedRendered === expected) {
      if (this.presentation.source !== 'page' || this.presentation.presentationId !== expected.presentationId || !this.sourceTrack()) this.clearRenderedPage();
      else {
        expected.accepted = true;
        if (expected.rendered && this.state.receiverSupportsPageAck) this.update({ receiverRenderedPage: true });
      }
    }
  }

  private async collectStats() {
    const peer = this.peerConnection;
    if (!peer || !this.events.stats) return;
    try {
      const report = await peer.getStats();
      if (peer !== this.peerConnection || this.disposed) return;
      report.forEach(item => {
        if (item.type !== 'outbound-rtp' || (item.kind !== 'video' && item.mediaType !== 'video')) return;
        const previous = this.previousStats;
        const seconds = previous ? (item.timestamp - previous.timestamp) / 1000 : 0;
        const bitrate = previous && seconds > 0 ? Math.max(0, (item.bytesSent - previous.bytes) * 8 / seconds) : 0;
        const fps = item.framesPerSecond ?? (previous && seconds > 0 ? Math.max(0, (item.framesEncoded - previous.frames) / seconds) : 0);
        const totalEncodeTime = nonNegativeStat(item.totalEncodeTime);
        const frames = previous ? item.framesEncoded - previous.frames : 0;
        const encodeSeconds = totalEncodeTime !== undefined && previous?.totalEncodeTime !== undefined
          ? totalEncodeTime - previous.totalEncodeTime : undefined;
        const encodeMsPerFrame = frames > 0 && encodeSeconds !== undefined && encodeSeconds >= 0
          ? encodeSeconds * 1000 / frames : undefined;
        const mediaSource = report.get(item.mediaSourceId);
        const source = mediaSource?.type === 'media-source' && (mediaSource.kind === 'video' || mediaSource.mediaType === 'video') ? mediaSource : undefined;
        const transport = report.get(item.transportId);
        const candidatePair = transport?.type === 'transport' ? report.get(transport.selectedCandidatePairId) : undefined;
        let remote: { fractionLost?: unknown; roundTripTime?: unknown } | undefined;
        report.forEach(candidate => {
          if (item.id && candidate.type === 'remote-inbound-rtp' && candidate.localId === item.id) remote = candidate;
        });
        this.previousStats = { timestamp: item.timestamp, bytes: item.bytesSent, frames: item.framesEncoded, totalEncodeTime };
        this.events.stats?.({
          framesPerSecond: fps, width: item.frameWidth ?? 0, height: item.frameHeight ?? 0, bitrate, codec: report.get(item.codecId)?.mimeType ?? '',
          codecFmtpLine: report.get(item.codecId)?.sdpFmtpLine,
          sourceWidth: nonNegativeStat(source?.width), sourceHeight: nonNegativeStat(source?.height), sourceFps: nonNegativeStat(source?.framesPerSecond),
          qualityLimitationReason: typeof item.qualityLimitationReason === 'string' ? item.qualityLimitationReason : undefined,
          encodeMsPerFrame,
          availableOutgoingBitrate: candidatePair?.type === 'candidate-pair' ? nonNegativeStat(candidatePair.availableOutgoingBitrate) : undefined,
          encoderImplementation: typeof item.encoderImplementation === 'string' ? item.encoderImplementation : undefined,
          powerEfficientEncoder: typeof item.powerEfficientEncoder === 'boolean' ? item.powerEfficientEncoder : undefined,
          fractionLost: nonNegativeStat(remote?.fractionLost), roundTripTime: nonNegativeStat(remote?.roundTripTime),
        });
      });
    } catch { /* Statistics do not gate preview or generation. */ }
  }

  private closePeer() {
    this.clearRenderedPage();
    const peer = this.peerConnection;
    this.peerConnection = null; this.sender = null; this.offerSent = false;
    this.localCandidates = []; this.remoteCandidates = []; this.publishedPresentation = ''; this.previousStats = undefined; this.disconnectedAt = undefined; this.peerInterrupted = false;
    if (peer) { peer.onicecandidate = null; peer.onconnectionstatechange = null; peer.close(); }
  }

  private clearRenderedPage() {
    this.expectedRendered = null;
    if (this.state.receiverRenderedPage) this.update({ receiverRenderedPage: false });
  }

  close() {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseWait?.finish();
    clearTimeout(this.pollTimer); clearTimeout(this.leaseTimer); clearTimeout(this.receiverTimer);
    this.requests.forEach(request => request.abort()); this.closePeer();
    const session = this.state.session; this.state = { ...this.state, session: null, status: 'closed', receiverRenderedPage: false };
    if (session) void this.deps.request('close', { sessionId: session.sessionId, token: session.token }).catch(() => undefined);
  }
}
