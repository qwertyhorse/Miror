import { ProviderSettingsForm } from './ProviderSettingsForm';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import { isExhibitionLocallyEnded, type ExhibitionCredentialsStatus } from '../../shared/exhibition';
import { isXmaxRegion, type XmaxRegion } from '../../shared/xmax';
import { appUrl } from '../versionScope';
import { exhibitionApiPath, exhibitionUrl } from './mirrorApi';
import type { ExhibitionController } from './useExhibition';
import type { ExhibitionLiveController } from './useExhibitionLive';
import './mirror-credential-settings.css';

interface Props { controller: ExhibitionController; live: ExhibitionLiveController; embedded?: boolean; }

const FRAME_MESSAGE = 'openbuy:mirror-credential';
const HTTP_PARENT_PORTS = new Set(['10200', '10201', '10601', '10101']);
const REGIONS: readonly { value: XmaxRegion; label: string }[] = [{ value: 'cn', label: '国内版' }, { value: 'global', label: '国际版' }];
const frameHeight = (height: number) => Math.max(68, Math.min(800, Math.ceil(height)));
const currentPageUrl = () => new URL(typeof window === 'undefined' ? 'http://xuminghong.local:10200/v1.1/exhibition/control' : window.location.href);

function secureFormUrl(mirrorId: string) {
  const page = currentPageUrl();
  const url = new URL(exhibitionUrl('/exhibition/control', mirrorId), page);
  url.protocol = 'https:'; url.port = '10202'; url.searchParams.set('credentialForm', '1');
  url.searchParams.set('parentOrigin', page.origin);
  return url;
}

function notifyParent(mirrorId: string, detail: { height?: number; saved?: true }) {
  if (window.parent === window) return;
  const page = currentPageUrl();
  let origin = new URL(page.origin); origin.protocol = 'http:'; origin.port = '10200';
  const requestedOrigin = page.searchParams.get('parentOrigin');
  if (requestedOrigin !== null) {
    try {
      const candidate = new URL(requestedOrigin);
      if (candidate.protocol !== 'http:' || candidate.hostname !== page.hostname || !HTTP_PARENT_PORTS.has(candidate.port)
        || requestedOrigin !== candidate.origin) return;
      origin = candidate;
    } catch { return; }
  }
  window.parent.postMessage({ type: FRAME_MESSAGE, mirrorId, ...detail }, origin.origin);
}

function safeStatus(value: unknown): ExhibitionCredentialsStatus | null {
  if (!value || typeof value !== 'object') return null;
  const status = value as Record<string, unknown>;
  if (typeof status.configured !== 'boolean' || typeof status.editable !== 'boolean'
    || !['mirror', 'default'].includes(String(status.source))
    || (status.region !== undefined && !isXmaxRegion(status.region))
    || (status.hasUnconfirmedSession !== undefined && typeof status.hasUnconfirmedSession !== 'boolean')
    || !['revision', 'perSessionLimit'].every(key => typeof status[key] === 'number' && Number.isFinite(status[key]) && (status[key] as number) >= 0)) return null;
  return {
    configured: status.configured, editable: status.editable,
    source: status.source as 'mirror' | 'default', revision: status.revision as number,
    region: isXmaxRegion(status.region) ? status.region : 'global', hasUnconfirmedSession: status.hasUnconfirmedSession === true,
    perSessionLimit: status.perSessionLimit as number,
  };
}

export function MirrorCredentialSettings(props: Props) {
  return currentPageUrl().protocol === 'https:'
    ? <CredentialSettings key={props.controller.mirrorId} {...props} />
    : <CredentialFrame key={props.controller.mirrorId} {...props} />;
}

function CredentialFrame({ controller, live }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(76);
  const mirrorId = controller.mirrorId;
  const url = secureFormUrl(mirrorId);
  const refresh = useRef({ controller, live });
  refresh.current = { controller, live };
  useEffect(() => {
    function receive(event: MessageEvent) {
      if (!frame.current?.contentWindow || event.origin !== url.origin || event.source !== frame.current.contentWindow) return;
      const data: unknown = event.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      const message = data as Record<string, unknown>;
      if (message.type !== FRAME_MESSAGE || message.mirrorId !== mirrorId
        || Object.keys(message).some(key => !['type', 'mirrorId', 'height', 'saved'].includes(key))
        || ('height' in message && (typeof message.height !== 'number' || !Number.isFinite(message.height)))
        || ('saved' in message && message.saved !== true)) return;
      if (typeof message.height === 'number') setHeight(frameHeight(message.height));
      if (message.saved === true) void Promise.allSettled([refresh.current.controller.refresh(), refresh.current.live.refreshStatus()]);
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [mirrorId, url.origin]);
  return <div id="mirror-sk-settings" className="ex-credential-frame-wrap"><iframe ref={frame} title="换装服务配置" className="ex-credential-frame" src={url.href} style={{ height }} /></div>;
}

function CredentialSettings({ controller, live, embedded = false }: Props) {
  const mirrorId = controller.mirrorId;
  const endpoint = appUrl(`/api${exhibitionApiPath('credentials', mirrorId)}`);
  const [status, setStatus] = useState<ExhibitionCredentialsStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [region, setRegion] = useState<XmaxRegion>('global');
  const regionDirty = useRef(false);
  const statusRevision = useRef<number | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(false);
  const busy = useRef(false);
  const epoch = useRef(0);
  const requests = useRef(new Set<AbortController>());
  const section = useRef<HTMLDivElement>(null);
  const configurable = !!controller.state && ((['idle', 'select'].includes(controller.state.phase) && !controller.state.live)
    || (controller.state.phase === 'paused' && controller.state.live?.status === 'error') || isExhibitionLocallyEnded(controller.state));
  const disabled = saving || controller.pending || !controller.connected || !configurable || !status?.editable;
  const currentRegion = status?.configured ? status.region ?? 'global' : null;
  const regionChanged = !!status && region !== (status.region ?? 'global');

  useEffect(() => {
    if (!embedded || !section.current) return;
    const measure = () => notifyParent(mirrorId, { height: frameHeight(section.current!.getBoundingClientRect().height + 4) });
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(section.current);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [embedded, mirrorId]);

  useEffect(() => {
    if (embedded && section.current) notifyParent(mirrorId, { height: frameHeight(section.current.getBoundingClientRect().height + 4) });
  }, [embedded, mirrorId, status, region, error, saving, saved]);

  useEffect(() => {
    alive.current = true;
    async function refresh() {
      if (busy.current) return;
      const revision = ++epoch.current;
      const request = new AbortController(); requests.current.add(request);
      const timer = setTimeout(() => request.abort(), 8000);
      try {
        const response = await fetch(endpoint, { cache: 'no-store', signal: request.signal });
        const next = response.ok ? safeStatus(await response.json()) : null;
        if (!next) throw new Error('status');
        if (alive.current && revision === epoch.current) {
          const changed = statusRevision.current !== undefined && statusRevision.current !== next.revision;
          statusRevision.current = next.revision;
          if (changed) { setDraft(''); regionDirty.current = false; setSaved(false); }
          setStatus(next);
          if (!regionDirty.current) setRegion(next.region ?? 'global');
          setError(current => changed ? '配置已变化，请重新输入 SK。' : current === 'SK 配置读取失败。' ? '' : current);
        }
      } catch {
        if (alive.current && revision === epoch.current) setError('SK 配置读取失败。');
      } finally { clearTimeout(timer); requests.current.delete(request); }
    }
    void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    const timer = setInterval(focus, 10000);
    if (window.location.hash === '#mirror-sk-settings') section.current?.scrollIntoView?.({ block: 'center' });
    return () => {
      alive.current = false; epoch.current++;
      window.removeEventListener('focus', focus); clearInterval(timer);
      requests.current.forEach(request => request.abort()); requests.current.clear();
    };
  }, [endpoint]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (disabled || busy.current || !status) return;
    const apiKey = draft.trim();
    if (!/^uk-[A-Za-z0-9_-]+$/.test(apiKey)) { setError('请输入有效的 XMAX SK。'); return; }
    busy.current = true; ++epoch.current;
    setSaving(true); setSaved(false); setError(''); setDraft('');
    const request = new AbortController(); requests.current.add(request);
    const timer = setTimeout(() => request.abort(), 10000);
    try {
      const response = await fetch(endpoint, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, signal: request.signal,
        body: JSON.stringify({ apiKey, region, expectedRevision: status.revision }),
      });
      if (!response.ok) {
        if (response.status === 409) {
          const latest = await fetch(endpoint, { cache: 'no-store', signal: request.signal });
          const next = latest.ok ? safeStatus(await latest.json()) : null;
          if (alive.current && next) {
            setStatus(next); statusRevision.current = next.revision;
            setRegion(next.region ?? 'global'); regionDirty.current = false;
          }
          throw new Error('conflict');
        }
        if (response.status === 400) throw new Error('invalid');
        throw new Error('save');
      }
      const next = safeStatus(await response.json());
      if (!next) throw new Error('save');
      if (!alive.current) return;
      setStatus(next); statusRevision.current = next.revision;
      setRegion(next.region ?? 'global'); regionDirty.current = false; setSaved(true);
      if (embedded) notifyParent(mirrorId, { saved: true });
      await Promise.allSettled([controller.refresh(), live.refreshStatus()]);
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error && cause.message === 'conflict' ? '配置已变化，请重新输入 SK。'
        : cause instanceof Error && cause.message === 'invalid' ? '请输入有效的 XMAX SK。' : 'SK 保存失败，请重试。');
    } finally {
      clearTimeout(timer); requests.current.delete(request); busy.current = false;
      if (alive.current) setSaving(false);
    }
  }

  function changeRegion(next: XmaxRegion) {
    if (disabled || next === region) return;
    setRegion(next); regionDirty.current = true; setDraft(''); setSaved(false); setError('');
  }

  function regionKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    const index = REGIONS.findIndex(option => option.value === region);
    const next = event.key === 'Home' ? REGIONS[0]
      : event.key === 'End' ? REGIONS[REGIONS.length - 1]
      : ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)
        ? REGIONS[(index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + REGIONS.length) % REGIONS.length]
        : null;
    if (!next) return;
    event.preventDefault();
    changeRegion(next.value);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-region="${next.value}"]`)?.focus();
  }

  return <div id="mirror-sk-settings" ref={section} className="ex-mirror-credentials">
    <ProviderSettingsForm key={mirrorId} mirrorId={mirrorId} onSaved={() => { if (embedded) notifyParent(mirrorId, { saved: true }); void live.refreshStatus(); void controller.refresh(); }} />
    <div className="ex-credential-heading"><label htmlFor="mirror-xmax-sk">XMAX SK</label><span className="ex-credential-status">{!status ? '读取中…' : !status.configured ? '未配置' : status.source === 'mirror' ? '已配置' : '默认 SK'}</span>
      {currentRegion && <span className="ex-credential-current" data-current-region={currentRegion}>{`当前：${REGIONS.find(option => option.value === currentRegion)!.label}`}</span>}
      {regionChanged && <span className="ex-credential-unsaved" role="status">未保存</span>}
    </div>
    <form className="ex-credential-form" aria-label="XMAX SK 配置" onSubmit={event => void save(event)}>
      <div className="ex-credential-regions" role="radiogroup" aria-label="XMAX 服务区域">
        {REGIONS.map(option => <button key={option.value} type="button" role="radio" aria-checked={region === option.value} data-region={option.value} tabIndex={region === option.value ? 0 : -1} disabled={disabled} onClick={() => changeRegion(option.value)} onKeyDown={regionKeyDown}>
          <Check size={13} aria-hidden="true" /><span>{option.label}</span>
        </button>)}
      </div>
      <input id="mirror-xmax-sk" aria-label="XMAX SK" type="password" autoComplete="new-password" spellCheck={false} maxLength={512} value={draft} placeholder={status?.source === 'mirror' ? '输入新 SK' : '输入 SK'} disabled={disabled} onChange={event => { setDraft(event.target.value); setSaved(false); setError(''); }} />
      <button className="ex-button" type="submit" disabled={disabled || !draft.trim()}>{saving ? '正在保存…' : '保存 SK'}</button>
      {saved && <span className="ex-saved" role="status"><Check size={14} />已保存</span>}
    </form>
    {status?.hasUnconfirmedSession && <p className="ex-credential-warning" role="status">旧会话待核实，新配置仅用于后续体验。</p>}
    {error && <p className="ex-field-error" role="alert">{error}</p>}
  </div>;
}
