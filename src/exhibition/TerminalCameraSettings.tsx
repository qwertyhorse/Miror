import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, RefreshCw, X } from 'lucide-react';
import type { ExhibitionState } from '../../shared/exhibition';
import type { ExhibitionCameraDevice, ExhibitionCameraReport, ExhibitionCameraRequest } from '../../shared/exhibitionCamera';
import { EXHIBITION_CAMERA_REQUEST_TTL_MS } from '../../shared/exhibitionCamera';
import type { TerminalBinding, TerminalConnection, TerminalIdentity } from './useTerminalBinding';
import type { ExhibitionLiveController } from './useExhibitionLive';
import { cameraTrackDeviceId } from './cameraCapture';
import { readCameraPreference, saveCameraPreference } from './cameraPreference';
import { StreamVideo } from './LiveCameraPanel';
import './terminal-camera.css';

export function terminalCameraRequestMatches(request: ExhibitionCameraRequest | undefined | null, connection: TerminalConnection | null | undefined,
  identity: TerminalIdentity | null | undefined, mirrorId: string, now = Date.now()): request is ExhibitionCameraRequest {
  return !!request && identity?.platform === 'browser' && connection?.mirrorId === mirrorId
    && connection.terminalId === identity.terminalId && request.action === 'open'
    && request.mirrorId === mirrorId && request.terminalId === identity.terminalId
    && !!connection.cameraBindingId && request.bindingId === connection.cameraBindingId
    && request.createdAt <= now && request.expiresAt > now;
}

export function terminalCameraAvailable(state: ExhibitionState | null, pending = false): boolean {
  return !!state && !pending && ['idle', 'select'].includes(state.phase) && !state.live
    && (!state.lifecycle || (['idle', 'ended'].includes(state.lifecycle.state) && state.lifecycle.connection === 'idle'));
}

type TerminalCameraRequest = ExhibitionCameraRequest & { localPreview?: true };
const ignoreCameraReport = (_value: ExhibitionCameraReport) => {};

function reportFor(request: ExhibitionCameraRequest, status: ExhibitionCameraReport['status']): ExhibitionCameraReport {
  return { mirrorId: request.mirrorId, bindingId: request.bindingId, requestId: request.id,
    status, devices: [], selectedDeviceId: null, activeDeviceId: null };
}

/** Request identity is tied to a binding epoch, not to a mirror URL or browser tab URL. */
export function useTerminalCameraRequest(terminal: TerminalBinding | undefined, mirrorId: string, state: ExhibitionState | null, pending: boolean,
  allowLocalPreview = false) {
  const [accepted, setAccepted] = useState<TerminalCameraRequest | null>(null);
  const [interrupted, setInterrupted] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState('');
  const operation = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const seen = useRef('');
  const current = terminal?.connected ? terminal.connection : null;
  const incoming = current?.cameraRequest;
  const local = allowLocalPreview && !terminal?.identity;
  const bound = terminal?.identity?.platform === 'browser' && current?.mirrorId === mirrorId
    && current.terminalId === terminal.identity.terminalId && !!current.cameraBindingId;
  const matches = (value: TerminalCameraRequest | undefined | null) => value?.localPreview
    ? local && value.mirrorId === mirrorId && value.expiresAt > Date.now()
    : terminalCameraRequestMatches(value, current, terminal?.identity, mirrorId);
  const candidate = matches(incoming) && seen.current !== `${incoming!.bindingId}:${incoming!.id}` ? incoming! : null;
  const available = terminalCameraAvailable(state, pending);
  const interruptedRequest = matches(accepted) && !available ? accepted : null;
  const request: TerminalCameraRequest | null = matches(accepted) && available ? accepted : candidate && available ? candidate : null;
  const canOpen = available && !request && !opening && (local || (bound && !!terminal?.openCamera));
  const latest = useRef({ terminal, canOpen, available, matches, local, mirrorId, request });
  latest.current = { terminal, canOpen, available, matches, local, mirrorId, request };
  useEffect(() => {
    generation.current++;
    operation.current?.abort(); operation.current = null;
    setOpening(false); setOpenError(''); setInterrupted(false);
    return () => { generation.current++; operation.current?.abort(); operation.current = null; };
  }, [mirrorId, current?.cameraBindingId, current?.mirrorId, terminal?.identity?.terminalId, terminal?.connected, local]);
  useEffect(() => {
    if (interruptedRequest) {
      if (!interruptedRequest.localPreview) terminal?.reportCamera?.(reportFor(interruptedRequest, 'busy'));
      setAccepted(null); setInterrupted(true);
    } else if (interrupted && available) setInterrupted(false);
  }, [interruptedRequest, interrupted, available, terminal?.reportCamera]);
  useEffect(() => {
    if (!candidate) return;
    seen.current = `${candidate.bindingId}:${candidate.id}`;
    if (terminalCameraAvailable(state, pending)) setAccepted(candidate);
    else terminal?.reportCamera?.(reportFor(candidate, 'busy'));
  }, [candidate?.id, candidate?.bindingId, state, pending, terminal?.reportCamera]);
  useEffect(() => {
    if (!accepted) return;
    if (!matches(accepted)) { setAccepted(null); return; }
    const timer = setTimeout(() => setAccepted(null), Math.max(0, accepted.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [accepted, current?.mirrorId, current?.cameraBindingId, terminal?.connected, terminal?.identity?.terminalId, mirrorId, local]);
  const open = useCallback(async () => {
    const owner = latest.current;
    if (!owner.canOpen || operation.current) return;
    setOpenError('');
    if (owner.local) {
      const createdAt = Date.now();
      setAccepted({ id: `local-${globalThis.crypto.randomUUID()}`, action: 'open', localPreview: true, mirrorId: owner.mirrorId,
        terminalId: 'local-preview', bindingId: 'local-preview', createdAt, expiresAt: createdAt + EXHIBITION_CAMERA_REQUEST_TTL_MS });
      return;
    }
    const abort = new AbortController(); operation.current = abort;
    const epoch = generation.current; setOpening(true);
    try {
      const next = await owner.terminal!.openCamera!(owner.mirrorId, abort.signal);
      if (abort.signal.aborted || epoch !== generation.current || !latest.current.matches(next)) return;
      if (seen.current === `${next.bindingId}:${next.id}` && latest.current.request?.id !== next.id) {
        setOpenError('正在同步摄像头设置，请稍后重试。'); return;
      }
      seen.current = `${next.bindingId}:${next.id}`;
      if (!latest.current.available) {
        latest.current.terminal?.reportCamera?.(reportFor(next, 'busy'));
        setOpenError('结束体验后可切换'); return;
      }
      setAccepted(next);
    } catch (cause) {
      if (!abort.signal.aborted && epoch === generation.current) setOpenError(cause instanceof Error ? cause.message : '摄像头设置未打开，请重试。');
    } finally {
      if (operation.current === abort) operation.current = null;
      if (epoch === generation.current) setOpening(false);
    }
  }, []);
  // An unexpected begin cannot consume an unsaved diagnostic selection.
  return { request, blocksGeneration: opening || !!request || !!interruptedRequest || interrupted, canOpen, opening, openError, open,
    close: useCallback(() => setAccepted(null), []) };
}

export function TerminalCameraEntry({ settings, busy, connected }: {
  settings: ReturnType<typeof useTerminalCameraRequest>; busy: boolean; connected: boolean;
}) {
  if (busy) return null;
  const reason = !connected ? '镜端连接中断' : '';
  return <div className="ex-terminal-camera-entry" title={reason || '摄像头设置'}><button type="button" disabled={!settings.canOpen || !connected} onClick={() => void settings.open()}
    aria-label="摄像头" aria-busy={settings.opening} aria-describedby={reason ? 'terminal-camera-reason' : undefined}><Camera size={18} aria-hidden="true" /><span className="ex-sr-only">{settings.opening ? '正在打开…' : '摄像头'}</span></button>
    {reason && <span className="ex-sr-only" id="terminal-camera-reason">{reason}</span>}
    {settings.openError && <span className="ex-terminal-camera-entry-error" role="alert">{settings.openError}</span>}
  </div>;
}

function cameraDevices(devices: MediaDeviceInfo[]): ExhibitionCameraDevice[] {
  return devices.filter(device => device.kind === 'videoinput' && !!device.deviceId && device.deviceId.length <= 512 && !/[\u0000-\u001f\u007f]/.test(device.deviceId)).slice(0, 24).map((device, index) => ({
    id: device.deviceId, label: cameraText(device.label, 120) || `摄像头 ${index + 1}`, kind: 'unknown',
  }));
}
function cameraText(value: string, limit = 240) { return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit); }

/** The staff console receives device metadata only; it never receives this stream. */
export function useTerminalCameraReport(terminal: TerminalBinding | undefined, mirrorId: string, live: ExhibitionLiveController, request: ExhibitionCameraRequest | null) {
  const activeRequest = useRef(request); activeRequest.current = request;
  const bindingId = terminal?.connection?.cameraBindingId;
  const bound = terminal?.connected && terminal.identity?.platform === 'browser' && terminal.connection?.mirrorId === mirrorId;
  useEffect(() => {
    if (!bound || !bindingId || activeRequest.current) return;
    terminal?.reportCamera?.({ mirrorId, bindingId, requestId: null,
      status: live.opening ? 'scanning' : live.cameraError ? 'error' : live.cameraStream ? 'preview' : 'ready',
      devices: cameraDevices(live.cameras), selectedDeviceId: readCameraPreference()?.deviceId ?? null,
      activeDeviceId: live.cameraStream ? live.selectedCameraId || null : null, ...(live.cameraError ? { error: cameraText(live.cameraError) || '摄像头检测失败' } : {}),
    });
  }, [bound, bindingId, mirrorId, live.opening, live.cameraError, live.cameraStream, live.cameras, live.selectedCameraId, terminal?.reportCamera]);
}

export function TerminalCameraSettings({ request, live, report = ignoreCameraReport, close, keepPreview = true, cameraPreferenceScope }: { request: ExhibitionCameraRequest; live: ExhibitionLiveController;
  report?: (value: ExhibitionCameraReport) => void; close: () => void; keepPreview?: boolean; cameraPreferenceScope?: string }) {
  const previous = useRef({ stream: live.cameraStream, deviceId: live.selectedCameraId, preference: readCameraPreference(cameraPreferenceScope) });
  const current = useRef(live); current.current = live;
  const [devices, setDevices] = useState(() => cameraDevices(live.cameras));
  const [selected, setSelected] = useState(live.selectedCameraId || previous.current.preference?.deviceId || '');
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);
  const mounted = useRef(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const completed = useRef(false);
  const scanEpoch = useRef(0);
  const touched = useRef(false);
  const [previewFrame, setPreviewFrame] = useState<MediaStream | null>(null);
  const activeId = live.cameraStream ? cameraTrackDeviceId(live.cameraStream.getVideoTracks()[0]) || live.selectedCameraId : '';
  const previewReady = !!live.cameraStream && previewFrame === live.cameraStream && activeId === selected && devices.some(device => device.id === selected);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal?.();
    return () => element?.close?.();
  }, []);
  useEffect(() => { if (!selected && activeId) setSelected(activeId); }, [selected, activeId]);
  const publish = useCallback((status: ExhibitionCameraReport['status'], overrides: Partial<ExhibitionCameraReport> = {}) => report({
    ...reportFor(request, status), devices, selectedDeviceId: selected || null, activeDeviceId: activeId || null,
    ...((error || live.cameraError) ? { error: cameraText(error || live.cameraError) || '摄像头检测失败' } : {}), ...overrides,
  }), [request, report, devices, selected, activeId, error, live.cameraError]);
  const scan = useCallback(async () => {
    const epoch = ++scanEpoch.current;
    setScanning(true); setError('');
    try {
      if (!navigator.mediaDevices?.enumerateDevices) throw new Error('摄像头检测不可用，请重新打开镜端。');
      const next = cameraDevices(await navigator.mediaDevices.enumerateDevices());
      if (!mounted.current || epoch !== scanEpoch.current) return;
      setDevices(next);
      setSelected(value => value || current.current.selectedCameraId || next[0]?.id || '');
    } catch (cause) { if (mounted.current && epoch === scanEpoch.current) setError(cause instanceof Error ? cause.message : '检测失败，请重试。'); }
    finally { if (mounted.current && epoch === scanEpoch.current) setScanning(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void scan();
    const rescan = () => { void scan(); };
    navigator.mediaDevices?.addEventListener?.('devicechange', rescan);
    return () => {
      mounted.current = false; scanEpoch.current++;
      navigator.mediaDevices?.removeEventListener?.('devicechange', rescan);
      // A late permission result is cancelled on expiry, unbinding or navigation.
      if (!completed.current && touched.current) current.current.stopCamera();
    };
  }, [scan]);
  useEffect(() => {
    if (completed.current) return;
    publish(scanning || live.opening ? 'scanning' : (error || live.cameraError).includes('权限') ? 'permission-required' : previewReady ? 'preview' : 'ready');
  }, [publish, scanning, live.opening, live.cameraError, error, previewReady]);
  const preview = async (deviceId = selected) => {
    if (closing || live.opening || completed.current) return;
    setError(''); touched.current = true;
    const opened = await current.current.startCamera(deviceId || undefined, true);
    if (!mounted.current) return;
    if (opened) await scan();
  };
  const cancel = async () => {
    if (closing || completed.current) return;
    setClosing(true); completed.current = true;
    const original = previous.current;
    if (touched.current) {
      if (original.stream && original.deviceId) {
        if (original.stream !== current.current.cameraStream || current.current.opening) await current.current.startCamera(original.deviceId, true);
      } else current.current.stopCamera();
    }
    if (!mounted.current) return;
    publish('closed', { selectedDeviceId: original.preference?.deviceId ?? null,
      activeDeviceId: original.stream && current.current.cameraStream ? current.current.selectedCameraId || null : null, error: undefined });
    close();
  };
  const save = () => {
    if (!previewReady || closing || completed.current) return;
    try { saveCameraPreference({ deviceId: activeId, label: devices.find(device => device.id === activeId)?.label ?? '摄像头', profile: previous.current.preference?.profile ?? 'screen' }, cameraPreferenceScope); }
    catch { setError('无法保存摄像头选择，请允许浏览器保存网站数据。'); return; }
    completed.current = true; publish('closed', { error: undefined, activeDeviceId: keepPreview ? activeId || null : null });
    if (!keepPreview) current.current.stopCamera();
    close();
  };
  return <dialog ref={dialog} className="ex-terminal-camera" aria-labelledby="terminal-camera-title" onCancel={event => { event.preventDefault(); void cancel(); }}>
    <header><h2 id="terminal-camera-title"><Camera size={22} />摄像头</h2><button type="button" aria-label="取消摄像头设置" disabled={closing} onClick={() => void cancel()}><X size={22} /></button></header>
    <div className="ex-terminal-camera-preview">{live.cameraStream ? <StreamVideo stream={live.cameraStream} mirrored={live.mirrored} label="摄像头检测预览" onFirstFrame={setPreviewFrame} /> : <Camera size={44} />}</div>
    <div className="ex-terminal-camera-controls"><label>摄像头<select value={selected} disabled={live.opening || closing} onChange={event => { setSelected(event.target.value); void preview(event.target.value); }}>
      {!devices.some(device => device.id === selected) && <option value={selected}>{selected ? '已选摄像头未连接' : '选择摄像头'}</option>}
      {devices.map(device => <option key={device.id} value={device.id}>{device.label}</option>)}
    </select></label><button type="button" disabled={scanning || live.opening || closing} onClick={() => void scan()}><RefreshCw size={17} />重新检测</button></div>
    {(error || live.cameraError) ? <p className="ex-terminal-camera-error" role="alert">{error || live.cameraError}</p> : <p role="status">{scanning ? '正在检测…' : live.opening ? '正在开启摄像头…' : previewReady ? '画面正常' : devices.length ? '选择摄像头预览' : '未检测到摄像头'}</p>}
    <footer><button type="button" disabled={closing} onClick={() => void cancel()}>取消</button>{!previewReady && <button type="button" disabled={live.opening || closing} onClick={() => void preview()}>预览</button>}<button className="is-primary" type="button" disabled={!previewReady || live.opening || closing} onClick={save}>保存</button></footer>
  </dialog>;
}
