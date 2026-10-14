import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Monitor, Square } from 'lucide-react';
import type { ExhibitionMirrorSummary } from '../../shared/exhibition';
import { appUrl } from '../versionScope';
import { exhibitionApiPath } from './mirrorApi';
import { exhibitionBrowserTestUrl } from './cameraEntry';
import './browser-test.css';

interface BrowserTestSession { mirror: ExhibitionMirrorSummary; expiresAt: number; }
interface BrowserTestSnapshot {
  phase: 'loading' | 'ready' | 'error' | 'closing' | 'close-error' | 'closed';
  session: BrowserTestSession | null;
  error: string;
}
const TEST_ID = /^test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function testPath(id: string, suffix: string) { return appUrl(`/api${exhibitionApiPath(suffix, id)}`); }

function requestDeadline<T>(request: Promise<T>, milliseconds: number, message: string, onLateResult?: (value: T) => void): Promise<T> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { expired = true; reject(new Error(message)); }, milliseconds);
  });
  const result = request.then(value => { if (expired) onLateResult?.(value); return value; });
  return Promise.race([result, deadline]).finally(() => clearTimeout(timer));
}

/** One tab owns one ephemeral mirror; no terminal identity or registry storage is used. */
class BrowserTestClient {
  private snapshot: BrowserTestSnapshot = { phase: 'loading', session: null, error: '' };
  private listeners = new Set<() => void>();
  private started = false;
  private attached = false;
  private disposed = false;
  private disposal?: ReturnType<typeof setTimeout>;
  private expiry?: ReturnType<typeof setTimeout>;
  private closing?: Promise<void>;
  constructor(readonly sourceId: string, readonly testId: string | null) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<BrowserTestSnapshot>) {
    this.snapshot = { ...this.snapshot, ...update };
    this.listeners.forEach(listener => listener());
  }
  private remember(session: BrowserTestSession) {
    if (!this.attached || this.disposed) return;
    const url = new URL(window.location.href);
    url.searchParams.set('mirror', this.sourceId);
    url.searchParams.set('browserTest', session.mirror.id);
    window.history.replaceState(null, '', url);
  }
  private async closeRequest(id: string, keepalive = false) {
    const request = fetch(testPath(id, 'browser-test/close'), {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive,
      headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).then(async response => {
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        const code = result?.code ?? result?.error?.code;
        if ((response.status === 404 && code === 'BROWSER_TEST_NOT_FOUND')
          || (response.status === 410 && code === 'BROWSER_TEST_EXPIRED')) return;
        throw new Error(result?.message || '结束测试未确认，请重试。');
      }
    });
    await requestDeadline(request, 15000, '结束测试超时，请重试。');
  }
  private async load() {
    if (this.testId !== null && !TEST_ID.test(this.testId)) {
      this.publish({ phase: 'error', error: '测试已失效，请重新测试。' }); return;
    }
    try {
      const request = fetch(testPath(this.testId ?? this.sourceId, this.testId ? 'browser-test' : 'browser-tests'), {
        ...(this.testId ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
        credentials: 'same-origin', cache: 'no-store',
      }).then(async response => {
        const result = await response.json();
        if (!response.ok) throw new Error(result?.message || '测试暂不可用，请重新测试。');
        return result as BrowserTestSession;
      });
      const session = await requestDeadline(request, 10000, '连接测试超时，请重新测试。', result => {
        // Do not abort creation: a late response is our only handle for reclaiming an allocated mirror.
        const id = result?.mirror?.id;
        if (!this.testId && id && TEST_ID.test(id)) void this.closeRequest(id, true).catch(() => {});
      });
      const id = session?.mirror?.id;
      if (!id || !TEST_ID.test(id) || (this.testId && id !== this.testId)
        || session.mirror.binding || session.mirror.providerMode !== 'xmax'
        || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
        // A malformed create response can still have allocated an isolated mirror.
        if (!this.testId && id && TEST_ID.test(id)) void this.closeRequest(id, true).catch(() => {});
        throw new Error('测试信息无效，请重新测试。');
      }
      if (this.disposed) { void this.closeRequest(id, true).catch(() => {}); return; }
      this.remember(session);
      this.publish({ phase: 'ready', session, error: '' });
      this.expiry = setTimeout(() => { void this.close(); }, Math.max(0, session.expiresAt - Date.now()));
    } catch (cause) {
      if (!this.disposed) this.publish({ phase: 'error', error: cause instanceof Error ? cause.message : '测试暂不可用，请重新测试。' });
    }
  }
  start() {
    clearTimeout(this.disposal); this.attached = true;
    if (this.started) {
      if (this.snapshot.session) this.remember(this.snapshot.session);
      return;
    }
    this.started = true;
    void this.load();
  }
  stop() {
    this.attached = false;
    // React's StrictMode probe immediately reattaches this same client.
    this.disposal = setTimeout(() => {
      this.disposed = true; clearTimeout(this.expiry);
      const session = this.snapshot.session;
      if (session && this.snapshot.phase !== 'closed') void this.closeRequest(session.mirror.id, true).catch(() => {});
    }, 0);
  }
  close = (): Promise<void> => {
    if (this.closing) return this.closing;
    const session = this.snapshot.session;
    if (!session || this.snapshot.phase === 'closed') return Promise.resolve();
    clearTimeout(this.expiry);
    // Unmount the capture/RTC owner immediately, including when server cleanup needs a retry.
    this.publish({ phase: 'closing', error: '' });
    this.closing = this.closeRequest(session.mirror.id).then(() => {
      if (!this.disposed) this.publish({ phase: 'closed', error: '' });
    }, cause => {
      if (!this.disposed) this.publish({ phase: 'close-error', error: cause instanceof Error ? cause.message : '结束测试未确认，请重试。' });
    }).finally(() => { this.closing = undefined; });
    return this.closing;
  };
}

export function BrowserTestPage({ renderMirror }: { renderMirror: (mirror: ExhibitionMirrorSummary, controls: ReactNode) => ReactNode }) {
  const [client] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    const testId = query.get('browserTest');
    return new BrowserTestClient(query.get('mirror') || 'default', testId === '1' ? null : testId || 'invalid');
  });
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  useEffect(() => { client.start(); return () => client.stop(); }, [client]);
  useEffect(() => { document.title = 'OpenBuy.AI · 浏览器测试'; }, []);
  if (snapshot.phase === 'ready' && snapshot.session) return renderMirror(snapshot.session.mirror,
    <aside className="ex-browser-test-bar" aria-label="浏览器测试"><span><Monitor size={15} aria-hidden="true" />浏览器测试</span><button type="button" onClick={() => void client.close()}><Square size={13} aria-hidden="true" />结束测试</button></aside>);
  const loading = snapshot.phase === 'loading' || snapshot.phase === 'closing';
  return <main className="ex-app ex-connection-screen ex-browser-test-message"><Monitor size={32} aria-hidden="true" /><h1>{snapshot.phase === 'loading' ? '准备浏览器测试' : snapshot.phase === 'closing' ? '正在结束测试…' : snapshot.phase === 'closed' ? '测试已结束' : '浏览器测试'}</h1>
    {snapshot.error && <p role="alert">{snapshot.error}</p>}
    {!loading && (snapshot.phase === 'close-error' ? <button className="ex-button" onClick={() => void client.close()}>重试结束</button>
      : <a className="ex-button" href={exhibitionBrowserTestUrl(client.sourceId)}>重新测试</a>)}
  </main>;
}
