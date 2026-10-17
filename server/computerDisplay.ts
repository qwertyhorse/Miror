import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { COMPUTER_DISPLAY_TTL_MS, COMPUTER_DISPLAY_MAX_SDP_BYTES,
  type ComputerDisplayHostPoll, type ComputerDisplayHostSession, type ComputerDisplayMessage,
  type ComputerDisplayCapability, type ComputerDisplayOutput, type ComputerDisplayReceiverPoll, type ComputerDisplaySignal, type ComputerDisplaySource } from '../shared/computerDisplay.ts';
import { ApiError } from './types.ts';

interface Binding { terminalId: string; boundAt: number; }
interface Queue { messages: ComputerDisplayMessage[]; sequence: number; acknowledged: number; bytes: number; }
interface Session {
  id: string; mirrorId: string; deviceId: string; tokenHash: Buffer; output: ComputerDisplayOutput; binding: Binding | null;
  expiresAt: number; receiverId: string | null; receiverSeenAt: number | null; retiredReceivers: Set<string>;
  receiverCapabilities: ComputerDisplayCapability[];
  epoch: number; phase: 'idle' | 'offered' | 'answered'; readyEpoch: number;
  pagePresentation: { id: number; active: boolean; rendered: boolean } | null;
  host: Queue; receiver: Queue;
}
interface Options { binding: (mirrorId: string) => Binding | null; now?: () => number; maxSessions?: number; }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DEVICE = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_MESSAGES = 128;
const MAX_QUEUE_BYTES = 262_144;
const MAX_RECEIVER_RESTARTS = 32;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const hash = (value: string) => createHash('sha256').update(value).digest();
const queue = (): Queue => ({ messages: [], sequence: 0, acknowledged: 0, bytes: 0 });
const badInput = () => new ApiError('DISPLAY_INVALID_INPUT', '显示连接请求无效。', 400);
const stale = () => new ApiError('DISPLAY_SESSION_INVALID', '电脑显示连接已失效，请重新连接。', 409);
const unauthorized = () => new ApiError('DISPLAY_UNAUTHORIZED', '显示连接身份无效。', 403);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));

function signal(kind: unknown, payload: unknown): ComputerDisplaySignal {
  if (!record(payload) || !integer(payload.epoch)) throw badInput();
  const epoch = payload.epoch;
  if (kind === 'offer' || kind === 'answer') {
    if (!keys(payload, ['epoch', 'type', 'sdp']) || payload.type !== kind || typeof payload.sdp !== 'string'
      || !payload.sdp.length || Buffer.byteLength(payload.sdp) > COMPUTER_DISPLAY_MAX_SDP_BYTES) throw badInput();
    return kind === 'offer' ? { kind, payload: { epoch, type: kind, sdp: payload.sdp } }
      : { kind, payload: { epoch, type: kind, sdp: payload.sdp } };
  }
  if (kind === 'candidate') {
    const nullableText = (value: unknown, limit: number) => value === null || (typeof value === 'string' && value.length <= limit && !/[\r\n\u0000]/.test(value));
    if (!keys(payload, ['epoch', 'candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'])
      || typeof payload.candidate !== 'string' || payload.candidate.length > 4_096 || /[\r\n\u0000]/.test(payload.candidate)
      || !nullableText(payload.sdpMid, 128) || !(payload.sdpMLineIndex === null || (integer(payload.sdpMLineIndex) && payload.sdpMLineIndex <= 65_535))
      || (payload.usernameFragment !== undefined && !nullableText(payload.usernameFragment, 256))) throw badInput();
    return { kind, payload: { epoch, candidate: payload.candidate, sdpMid: payload.sdpMid as string | null,
      sdpMLineIndex: payload.sdpMLineIndex as number | null,
      ...(payload.usernameFragment === undefined ? {} : { usernameFragment: payload.usernameFragment as string | null }) } };
  }
  if (kind === 'ready' || kind === 'reset') {
    if (!keys(payload, ['epoch'])) throw badInput();
    return { kind, payload: { epoch } };
  }
  if (kind === 'rendered') {
    if (!keys(payload, ['epoch', 'presentationId']) || !integer(payload.presentationId)) throw badInput();
    return { kind, payload: { epoch, presentationId: payload.presentationId } };
  }
  if (kind === 'presentation') {
    const rotation = payload.rotation === undefined ? 0 : payload.rotation;
    if (!keys(payload, ['epoch', 'mirrored', 'source', 'rotation', 'active', 'presentationId']) || typeof payload.mirrored !== 'boolean'
      || !['camera', 'output', 'image', 'page'].includes(String(payload.source))
      || (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270)
      || (payload.source === 'page' ? typeof payload.active !== 'boolean' || payload.mirrored || rotation !== 0 || !integer(payload.presentationId)
        : payload.active !== undefined || payload.presentationId !== undefined)) throw badInput();
    return { kind, payload: { epoch, mirrored: payload.mirrored, source: payload.source as ComputerDisplaySource, rotation,
      ...(payload.source === 'page' ? { active: payload.active as boolean, presentationId: payload.presentationId as number } : {}) } };
  }
  throw badInput();
}

/** Ephemeral, bounded mailboxes. Never stores media, physical terminal secrets, or device data. */
export class ComputerDisplayBroker {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;
  private readonly maxSessions: number;
  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => performance.now());
    this.maxSessions = options.maxSessions ?? 32;
    if (!Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1 || this.maxSessions > 128) throw new Error('Invalid display session limit');
  }

  open(mirrorId: string, deviceId: unknown, output: unknown = 'android', replaceHost: unknown = false): ComputerDisplayHostSession {
    if (typeof deviceId !== 'string' || !DEVICE.test(deviceId) || (output !== 'android' && output !== 'browser') || typeof replaceHost !== 'boolean') throw badInput();
    this.sweep();
    const occupied = this.sessions.has(mirrorId);
    if (occupied && !replaceHost) throw new ApiError('DISPLAY_HOST_BUSY', '此智能镜已有电脑连接。', 409);
    if (!occupied && this.sessions.size >= this.maxSessions) throw new ApiError('DISPLAY_CAPACITY', '电脑显示连接已满。', 429);
    const binding = this.options.binding(mirrorId);
    if (!binding && output === 'android') throw new ApiError('DISPLAY_NOT_BOUND', '请先绑定安卓显示屏。', 409);
    const id = randomUUID(), token = randomBytes(32).toString('hex');
    // Replace atomically only after validation. Old polls, signals and late closes
    // retain their old capability and cannot renew or delete the replacement.
    this.sessions.set(mirrorId, { id, mirrorId, deviceId, tokenHash: hash(token), output,
      binding: binding ? { terminalId: binding.terminalId, boundAt: binding.boundAt } : null,
      expiresAt: this.now() + COMPUTER_DISPLAY_TTL_MS, receiverId: null, receiverSeenAt: null, retiredReceivers: new Set(), receiverCapabilities: [],
      epoch: 0, phase: 'idle', readyEpoch: -1, pagePresentation: null, host: queue(), receiver: queue() });
    return { sessionId: id, token, terminalId: `desktop-${id}` };
  }

  hostPoll(mirrorId: string, input: Record<string, unknown>): ComputerDisplayHostPoll {
    const session = this.hostSession(mirrorId, input.sessionId, input.token);
    const messages = this.poll(session.host, input.after);
    session.expiresAt = this.now() + COMPUTER_DISPLAY_TTL_MS;
    const receiverOnline = this.online(session);
    return { messages, receiverOnline, epoch: session.epoch, cursor: session.host.sequence,
      ...(receiverOnline && session.receiverCapabilities.length ? { receiverCapabilities: [...session.receiverCapabilities] } : {}) };
  }

  hostSignal(mirrorId: string, input: Record<string, unknown>): void {
    const session = this.hostSession(mirrorId, input.sessionId, input.token);
    if (session.output === 'browser') throw badInput();
    this.send(session, 'host', signal(input.kind, input.payload));
  }

  hostClose(mirrorId: string, input: Record<string, unknown>): void {
    const session = this.hostSession(mirrorId, input.sessionId, input.token);
    this.sessions.delete(session.mirrorId);
  }

  receiverPoll(mirrorId: string, terminalId: string, input: Record<string, unknown>): ComputerDisplayReceiverPoll {
    if (typeof input.receiverId !== 'string' || !UUID.test(input.receiverId) || !integer(input.after)
      || (input.sessionId !== undefined && input.sessionId !== null && (typeof input.sessionId !== 'string' || !UUID.test(input.sessionId)))) throw badInput();
    if (input.capabilities !== undefined && (!Array.isArray(input.capabilities) || input.capabilities.length > 16
      || input.capabilities.some(value => typeof value !== 'string' || value.length > 64))) throw badInput();
    const capabilities: ComputerDisplayCapability[] = ['page', 'page-rendered'].filter(value => Array.isArray(input.capabilities)
      && input.capabilities.includes(value)) as ComputerDisplayCapability[];
    const session = this.current(mirrorId);
    if (!session || session.output === 'browser') return { session: null, messages: [], epoch: 0, cursor: 0 };
    if (session.binding?.terminalId !== terminalId) throw unauthorized();
    if (session.retiredReceivers.has(input.receiverId)) throw stale();
    const replacement = session.receiverId !== input.receiverId;
    const reconnect = !this.online(session);
    if (replacement) {
      if (session.retiredReceivers.size >= MAX_RECEIVER_RESTARTS) { this.invalidate(mirrorId); throw stale(); }
      if (session.receiverId) {
        session.retiredReceivers.add(session.receiverId);
        // A new decoder cannot consume candidates/offers still in flight for the old peer.
        if (session.epoch >= Number.MAX_SAFE_INTEGER - 1) { this.invalidate(mirrorId); throw stale(); }
        session.epoch++;
      }
      session.receiverId = input.receiverId;
      session.phase = 'idle'; session.readyEpoch = -1; session.pagePresentation = null;
      this.clear(session.host); this.clear(session.receiver); session.receiver.acknowledged = 0;
    }
    const messages = this.poll(session.receiver, replacement || input.sessionId !== session.id ? 0 : input.after);
    if (replacement || reconnect) this.ready(session);
    session.receiverSeenAt = this.now();
    session.receiverCapabilities = capabilities;
    return { session: { id: session.id, deviceId: session.deviceId }, messages, epoch: session.epoch, cursor: session.receiver.sequence };
  }

  receiverSignal(mirrorId: string, terminalId: string, input: Record<string, unknown>): void {
    const session = this.current(mirrorId);
    if (!session || input.sessionId !== session.id) throw stale();
    if (session.output === 'browser' || session.binding?.terminalId !== terminalId || input.receiverId !== session.receiverId || !this.online(session)) throw unauthorized();
    this.send(session, 'receiver', signal(input.kind, input.payload));
  }

  /** Returns false for physical terminals; desktop IDs must always pass this capability check. */
  assertDesktopOwner(mirrorId: string, input: Record<string, unknown>): boolean {
    if (typeof input.terminalId !== 'string' || !input.terminalId.startsWith('desktop-')) return false;
    const session = this.hostSession(mirrorId, input.terminalId.slice('desktop-'.length), input.terminalToken);
    if (input.deviceId !== session.deviceId) throw unauthorized();
    return true;
  }

  hasHost(mirrorId: string): boolean { return this.current(mirrorId) !== null; }
  invalidate(mirrorId: string): void { this.sessions.delete(mirrorId); }
  closeAll(): void { this.sessions.clear(); }
  sweep(): void { for (const id of this.sessions.keys()) this.current(id); }

  private current(mirrorId: string): Session | null {
    const session = this.sessions.get(mirrorId);
    if (!session) return null;
    let binding: Binding | null;
    try { binding = this.options.binding(mirrorId); } catch { this.invalidate(mirrorId); return null; }
    if (this.now() >= session.expiresAt || binding?.terminalId !== session.binding?.terminalId || binding?.boundAt !== session.binding?.boundAt) {
      this.sessions.delete(mirrorId); return null;
    }
    return session;
  }

  private hostSession(mirrorId: string, id: unknown, token: unknown): Session {
    const session = this.current(mirrorId);
    if (!session || id !== session.id || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)
      || !timingSafeEqual(hash(token), session.tokenHash)) throw unauthorized();
    return session;
  }

  private online(session: Session): boolean {
    return session.output === 'browser' || (session.receiverSeenAt !== null && this.now() - session.receiverSeenAt < COMPUTER_DISPLAY_TTL_MS);
  }

  private ready(session: Session): void {
    if (session.readyEpoch === session.epoch) return;
    this.append(session.host, { kind: 'ready', payload: { epoch: session.epoch } });
    session.readyEpoch = session.epoch;
  }

  private send(session: Session, sender: 'host' | 'receiver', message: ComputerDisplaySignal): void {
    const { kind, payload } = message;
    if ((sender === 'host' && ['answer', 'ready', 'rendered'].includes(kind)) || (sender === 'receiver' && ['offer', 'presentation'].includes(kind))) throw badInput();
    if (kind === 'offer') {
      if (!this.online(session) || payload.epoch !== session.epoch + 1 || session.epoch >= Number.MAX_SAFE_INTEGER - 1) throw stale();
      this.clear(session.host); this.clear(session.receiver);
      this.append(session.receiver, message);
      session.epoch = payload.epoch; session.phase = 'offered'; session.pagePresentation = null;
      return;
    }
    if (kind === 'rendered') {
      const page = session.pagePresentation;
      // A stop, a new share or receiver restart can overtake an in-flight frame ACK.
      if (!session.receiverCapabilities.includes('page-rendered') || payload.epoch !== session.epoch || !page?.active
        || page.id !== payload.presentationId || page.rendered || session.phase !== 'answered') return;
      this.append(session.host, message); page.rendered = true; return;
    }
    if (payload.epoch !== session.epoch) throw stale();
    if (kind === 'presentation' && payload.source === 'page' && !session.receiverCapabilities.includes('page'))
      throw new ApiError('DISPLAY_PAGE_UNSUPPORTED', '请更新安卓 App 后再无线投屏。', 409);
    if (kind === 'ready') { this.ready(session); return; }
    if (kind === 'answer' && session.phase !== 'offered') throw stale();
    if (kind === 'candidate' && session.phase === 'idle') throw stale();
    if (kind === 'reset') { this.clear(session.host); this.clear(session.receiver); session.phase = 'idle'; session.pagePresentation = null; }
    if (kind === 'presentation' && payload.source === 'page' && session.pagePresentation
      && (payload.presentationId! < session.pagePresentation.id || (payload.presentationId === session.pagePresentation.id && payload.active !== session.pagePresentation.active))) throw stale();
    this.append(sender === 'host' ? session.receiver : session.host, message);
    if (kind === 'presentation') session.pagePresentation = payload.source === 'page'
      ? { id: payload.presentationId!, active: payload.active === true,
        rendered: session.pagePresentation?.id === payload.presentationId && session.pagePresentation?.rendered === true }
      : null;
    if (kind === 'answer') session.phase = 'answered';
  }

  private append(target: Queue, value: ComputerDisplaySignal): void {
    const size = Buffer.byteLength(JSON.stringify(value));
    if (target.messages.length >= MAX_MESSAGES || target.bytes + size > MAX_QUEUE_BYTES || target.sequence >= Number.MAX_SAFE_INTEGER - 1)
      throw new ApiError('DISPLAY_SIGNAL_CAPACITY', '显示信令繁忙，请重新连接。', 429);
    target.messages.push({ ...structuredClone(value), sequence: ++target.sequence }); target.bytes += size;
  }

  private poll(target: Queue, after: unknown): ComputerDisplayMessage[] {
    if (!integer(after) || after < target.acknowledged || after > target.sequence) throw new ApiError('DISPLAY_CURSOR_INVALID', '显示信令顺序已变化，请重新连接。', 409);
    target.acknowledged = after;
    target.messages = target.messages.filter(message => message.sequence > after);
    target.bytes = target.messages.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify({ kind: message.kind, payload: message.payload })), 0);
    return structuredClone(target.messages);
  }

  private clear(target: Queue): void { target.messages = []; target.bytes = 0; }
}
