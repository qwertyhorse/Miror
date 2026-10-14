import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { appUrl, scopedLocalStorage } from '../versionScope';
import type { ExhibitionDeviceConnectInput, ExhibitionDeviceConnection } from '../../shared/exhibition';
import type { ExhibitionCameraReport, ExhibitionCameraRequest, ExhibitionCameraStatus } from '../../shared/exhibitionCamera';

export type TerminalIdentity = ExhibitionDeviceConnectInput;
export type TerminalConnection = ExhibitionDeviceConnection;
interface TerminalSnapshot { ready: boolean; identity: TerminalIdentity | null; connection: TerminalConnection | null; connected: boolean; error: string; }
export interface TerminalDependencies {
  identity: (signal: AbortSignal) => Promise<TerminalIdentity | null>;
  create: () => TerminalIdentity;
  connect: (identity: TerminalIdentity, signal: AbortSignal) => Promise<TerminalConnection>;
  openCamera?: (mirrorId: string, terminalId: string, bindingId: string, signal: AbortSignal) => Promise<ExhibitionCameraStatus>;
}
const STORAGE_KEY = 'exhibition-terminal-identity';
function validIdentity(value: unknown): value is TerminalIdentity {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<TerminalIdentity>;
  return typeof item.terminalId === 'string' && /^terminal-[a-f0-9-]{36}$/.test(item.terminalId)
    && typeof item.token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(item.token)
    && typeof item.label === 'string' && ['android', 'browser'].includes(item.platform ?? '');
}
async function request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) abort.abort();
  const timer = setTimeout(cancel, 8000);
  try {
    const response = await fetch(appUrl(`/api/exhibition/${path}`), { cache: 'no-store', signal: abort.signal,
      ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message ?? '镜端连接未完成，请重试。');
    return data as T;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
}
export function createBrowserTerminal(): TerminalIdentity {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  const terminalId = `terminal-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  const identity: TerminalIdentity = { terminalId, token, label: '浏览器镜端', platform: 'browser' };
  scopedLocalStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  return identity;
}
const defaults: TerminalDependencies = {
  identity: async signal => {
    const native = await request<{ native: boolean } & Partial<TerminalIdentity>>('native-identity', signal);
    if (native.native) {
      if (!validIdentity(native)) throw new Error('镜端设备身份无效，请重启客户端。');
      return { terminalId: native.terminalId, token: native.token, label: native.label, platform: 'android' };
    }
    const saved = scopedLocalStorage.getItem(STORAGE_KEY);
    if (!saved) return null;
    let identity: unknown;
    try { identity = JSON.parse(saved); } catch { throw new Error('本机绑定信息损坏，请联系工作人员重新配置。'); }
    if (!validIdentity(identity)) throw new Error('本机绑定信息无效，请联系工作人员重新配置。');
    return identity;
  },
  create: createBrowserTerminal,
  connect: (identity, signal) => request<TerminalConnection>('terminals/connect', signal, identity),
  openCamera: (mirrorId, terminalId, bindingId, signal) => request<ExhibitionCameraStatus>(`mirrors/${encodeURIComponent(mirrorId)}/camera`, signal,
    { terminalId, bindingId, action: 'open' }),
};

/** The terminal identity outlives page leases; stopped epochs never claim a new screen. */
export class TerminalBindingClient {
  private snapshot: TerminalSnapshot = { ready: false, identity: null, connection: null, connected: false, error: '' };
  private listeners = new Set<() => void>();
  private scope: AbortController | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private booting = false;
  private polling = false;
  private cameraReport: ExhibitionCameraReport | undefined;
  private deferredCameraMetadata: ExhibitionCameraReport | undefined;
  private pollAgain = false;
  constructor(private deps: TerminalDependencies = defaults) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<TerminalSnapshot>) { this.snapshot = { ...this.snapshot, ...update }; this.listeners.forEach(listener => listener()); }
  private current(scope: AbortController) { return this.scope === scope && !scope.signal.aborted; }
  start() {
    if (this.scope) return;
    const scope = new AbortController(); this.scope = scope;
    this.booting = false; this.polling = false; this.cameraReport = undefined; this.deferredCameraMetadata = undefined; this.pollAgain = false;
    this.publish({ ready: false, identity: null, connection: null, connected: false, error: '' });
    void this.boot(scope);
  }
  stop() { const scope = this.scope; this.scope = null; scope?.abort(); clearTimeout(this.timer); }
  private async boot(scope: AbortController) {
    if (this.booting || !this.current(scope)) return;
    this.booting = true;
    try {
      const identity = await this.deps.identity(scope.signal);
      if (!this.current(scope)) return;
      this.publish({ identity, ready: true, error: '' });
      if (identity) await this.poll(scope);
    } catch (cause) {
      if (this.current(scope)) this.publish({ ready: true, connected: false, error: cause instanceof Error ? cause.message : '无法读取镜端身份，请重试。' });
    } finally { if (this.current(scope)) this.booting = false; }
  }
  private async poll(scope: AbortController) {
    if (!this.current(scope) || !this.snapshot.identity || this.polling) return;
    clearTimeout(this.timer); this.polling = true;
    try {
      const identity = this.snapshot.identity;
      const sentCameraReport = this.cameraReport;
      const result = await this.deps.connect(identity.platform === 'browser'
        ? { ...identity, cameraCapabilities: { version: 1 }, ...(sentCameraReport ? { cameraReport: sentCameraReport } : {}) }
        : identity, scope.signal);
      if (!this.current(scope)) return;
      if (result.terminalId !== this.snapshot.identity.terminalId) throw new Error('返回的设备身份不匹配，请重新连接。');
      if (this.cameraReport && (result.mirrorId !== this.cameraReport.mirrorId || result.cameraBindingId !== this.cameraReport.bindingId)) {
        this.cameraReport = undefined; this.deferredCameraMetadata = undefined;
      } else if (sentCameraReport && this.cameraReport === sentCameraReport && result.cameraReportAccepted !== undefined
        && sentCameraReport.requestId && ['closed', 'error', 'busy'].includes(sentCameraReport.status)) {
        this.cameraReport = this.deferredCameraMetadata; this.deferredCameraMetadata = undefined;
        if (this.cameraReport) this.pollAgain = true;
      }
      this.publish({ connection: result, connected: true, error: '' });
    } catch (cause) {
      if (this.current(scope)) this.publish({ connected: false, error: cause instanceof Error ? cause.message : '镜端连接中断，正在重试。' });
    } finally {
      if (this.current(scope)) {
        this.polling = false;
        const delay = this.pollAgain ? 0 : 10000; this.pollAgain = false;
        this.timer = setTimeout(() => void this.poll(scope), delay);
      }
    }
  }
  retry = async () => { if (this.scope) { if (this.snapshot.identity) await this.poll(this.scope); else await this.boot(this.scope); } };
  openCamera = async (mirrorId: string, signal?: AbortSignal): Promise<ExhibitionCameraRequest> => {
    const scope = this.scope;
    const identity = this.snapshot.identity;
    const binding = this.snapshot.connection;
    if (!scope || !this.snapshot.connected || identity?.platform !== 'browser' || !binding?.cameraBindingId
      || binding.mirrorId !== mirrorId || binding.terminalId !== identity.terminalId) throw new Error('请从已绑定的镜端切换摄像头。');
    const operation = new AbortController();
    const abort = () => operation.abort();
    scope.signal.addEventListener('abort', abort, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    if (scope.signal.aborted || signal?.aborted) abort();
    try {
      if (operation.signal.aborted) throw new DOMException('已取消摄像头设置。', 'AbortError');
      const result = await (this.deps.openCamera ?? defaults.openCamera!)(mirrorId, identity.terminalId, binding.cameraBindingId, operation.signal);
      const current = this.snapshot.connection;
      if (operation.signal.aborted || !this.current(scope) || !this.snapshot.connected || this.snapshot.identity !== identity
        || current?.mirrorId !== mirrorId || current?.cameraBindingId !== binding.cameraBindingId || current.terminalId !== identity.terminalId)
        throw new DOMException('镜端绑定已变化，请重试。', 'AbortError');
      const cameraRequest = result.request;
      if (!cameraRequest || cameraRequest.action !== 'open' || cameraRequest.mirrorId !== mirrorId || cameraRequest.terminalId !== identity.terminalId
        || cameraRequest.bindingId !== binding.cameraBindingId || cameraRequest.createdAt > Date.now() || cameraRequest.expiresAt <= Date.now())
        throw new Error('摄像头请求已失效，请重试。');
      return cameraRequest;
    } finally {
      scope.signal.removeEventListener('abort', abort);
      signal?.removeEventListener('abort', abort);
    }
  };
  reportCamera = (report: ExhibitionCameraReport) => {
    const connection = this.snapshot.connection;
    if (!this.scope || !this.snapshot.connected || this.snapshot.identity?.platform !== 'browser'
      || connection?.mirrorId !== report.mirrorId || connection.cameraBindingId !== report.bindingId) return;
    if (!report.requestId && this.cameraReport?.requestId && ['closed', 'error', 'busy'].includes(this.cameraReport.status)) {
      // Closing a dialog releases a server gate. Never let a routine camera
      // update replace that completion before the server acknowledges it.
      this.deferredCameraMetadata = report; return;
    }
    if (JSON.stringify(this.cameraReport) === JSON.stringify(report)) return;
    this.cameraReport = report;
    if (this.polling) this.pollAgain = true;
    else void this.poll(this.scope);
  };
  beginPairing = () => {
    if (!this.scope || this.snapshot.identity) return;
    try {
      const identity = this.deps.create();
      this.publish({ ready: true, identity, connected: false, connection: null, error: '' });
      void this.poll(this.scope);
    } catch { this.publish({ error: '无法保存本机身份，请允许浏览器保存网站数据后重试。' }); }
  };
}
export function useTerminalBinding(active: boolean) {
  const client = useMemo(() => new TerminalBindingClient(), []);
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  useEffect(() => { if (active) client.start(); return () => client.stop(); }, [client, active]);
  return { ...state, retry: client.retry, beginPairing: client.beginPairing,
    openCamera: client.openCamera as ((mirrorId: string, signal?: AbortSignal) => Promise<ExhibitionCameraRequest>) | undefined,
    reportCamera: client.reportCamera as ((report: ExhibitionCameraReport) => void) | undefined };
}
export type TerminalBinding = ReturnType<typeof useTerminalBinding>;
