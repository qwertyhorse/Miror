import { useEffect, useMemo, useRef, useState } from 'react';
import { Cast, Maximize2, Monitor, RotateCcw, Square, X } from 'lucide-react';
import { Kiosk } from './ExhibitionApp';
import { useExhibition } from './useExhibition';
import { useExhibitionLive } from './useExhibitionLive';
import { LiveCameraPanel } from './LiveCameraPanel';
import { ComputerDisplaySender, type ComputerDisplayOutput, type ComputerDisplayState, type ComputerDisplayStats } from './computerDisplay';
import { saveCameraPreference } from './cameraPreference';
import { orientExhibitionCamera, type ExhibitionCameraRotation } from './cameraOrientation';
import { computerCameraProfile, computerCameraQuality, computerDisplayQuality, computerDisplayFrameRate,
  CAMERA_RESOLUTION_OPTIONS, COMPUTER_RESOLUTION_OPTIONS, isComputerCameraResolution, isComputerResolution,
  type ComputerCameraQuality, type ComputerDisplayQuality, type ComputerDisplayFrameRate } from './cameraQuality';
import { scopedLocalStorage } from '../versionScope';
import { useHdmiPresentation } from './useHdmiPresentation';
import { HdmiDisplayPanel } from './HdmiDisplayPanel';
import { useWirelessPresentation } from './useWirelessPresentation';
import './wireless-display.css';

const initialDisplay: ComputerDisplayState = { session: null, status: 'opening', receiverOnline: false, error: '' };
const displayLabels: Record<ComputerDisplayState['status'], string> = {
  opening: '正在连接大屏', releasing: '正在等待体验结束', waiting: '等待大屏', connecting: '正在连接视频', connected: '大屏已连接', error: '连接已断开', closed: '连接已关闭',
};
function rotationKey(scope: string) { return `exhibition-camera-rotation:${encodeURIComponent(scope)}`; }
function qualityKey(scope: string) { return `exhibition-camera-quality:${encodeURIComponent(scope)}`; }
function outputKey(scope: string) { return `exhibition-display-settings:${encodeURIComponent(scope)}`; }
function savedOutput(scope: string): { quality: ComputerDisplayQuality; frameRate: ComputerDisplayFrameRate; edited: boolean } {
  try {
    const stored = scopedLocalStorage.getItem(outputKey(scope));
    if (stored) {
      const value = JSON.parse(stored);
      return { quality: computerDisplayQuality(value.quality), frameRate: computerDisplayFrameRate(value.frameRate), edited: false };
    }
    const previous = scopedLocalStorage.getItem(qualityKey(scope));
    return { quality: previous === '1080p' || previous === '4k' ? previous : previous ? '1080p' : '4k', frameRate: 30, edited: false };
  } catch { return { quality: '4k', frameRate: 30, edited: false }; }
}
function savedWirelessOutput(scope: string) {
  try {
    const stored = JSON.parse(scopedLocalStorage.getItem(outputKey(scope)) || '{}');
    return { quality: (['1080p', 'l1', 'l2', 'l3', 'l4'].includes(stored.quality) ? stored.quality : '1080p') as ComputerDisplayQuality,
      frameRate: computerDisplayFrameRate(stored.frameRate), edited: false };
  } catch { return { quality: '1080p' as ComputerDisplayQuality, frameRate: 30 as ComputerDisplayFrameRate, edited: false }; }
}
function savedQuality(scope: string): ComputerCameraQuality {
  try { return computerCameraQuality(scopedLocalStorage.getItem(qualityKey(scope))); }
  catch { return '1080p'; }
}
function savedRotation(scope: string): ExhibitionCameraRotation {
  try {
    const value = Number(scopedLocalStorage.getItem(rotationKey(scope)));
    if (value === 90 || value === 180 || value === 270) return value;
  } catch { /* An unavailable preference keeps the direct camera stream. */ }
  return 0;
}

/** Camera, gestures and cloud generation all remain in this computer browser. */
export function ComputerSource({ mirrorId, output: outputTarget = 'android', presentation }: { mirrorId: string; output?: ComputerDisplayOutput; presentation?: 'hdmi' | 'wireless' }) {
  const browserOutput = outputTarget === 'browser';
  const hdmiMode = browserOutput && presentation === 'hdmi';
  const wirelessMode = !browserOutput && presentation === 'wireless';
  const cameraPreferenceScope = `computer-${mirrorId}`;
  const outputPreferenceScope = wirelessMode ? `wireless-${mirrorId}` : cameraPreferenceScope;
  const controller = useExhibition(mirrorId);
  const { state, connected, refresh } = controller;
  const [display, setDisplay] = useState<ComputerDisplayState>(initialDisplay);
  const [stats, setStats] = useState<ComputerDisplayStats | null>(null);
  const [retry, setRetry] = useState({ attempt: 0, waitForRelease: false, replaceHost: false });
  const [stoppingForConnection, setStoppingForConnection] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [receiverExpired, setReceiverExpired] = useState(false);
  const [armed, setArmed] = useState(false);
  const [cameraSettings, setCameraSettings] = useState(false);
  const [rotation, setRotation] = useState<ExhibitionCameraRotation>(() => savedRotation(cameraPreferenceScope));
  const [quality, setQuality] = useState<ComputerCameraQuality>(() => savedQuality(cameraPreferenceScope));
  const [outputSettings, setOutputSettings] = useState(() => wirelessMode
    ? savedWirelessOutput(outputPreferenceScope)
    : savedOutput(cameraPreferenceScope));
  const [outputPending, setOutputPending] = useState(false);
  const [outputError, setOutputError] = useState('');
  const [outputRetry, setOutputRetry] = useState(0);
  const [cameraSettingsError, setCameraSettingsError] = useState('');
  const [fullError, setFullError] = useState('');
  const sender = useRef<ComputerDisplaySender | null>(null);
  const takeover = useRef<{ transport: ComputerDisplaySender } | null>(null);
  const pageActive = useRef(true);
  const wirelessOwnedHost = useRef(false);
  const hdmiDisconnect = useRef<() => Promise<boolean>>(async () => true);
  const hdmi = useHdmiPresentation(hdmiMode, () => hdmiDisconnect.current());
  const hdmiBlocked = hdmiMode && (!hdmi.ready || hdmi.needsStop);
  const wirelessTarget = useRef<HTMLDivElement | null>(null);
  const wireless = useWirelessPresentation(wirelessMode, wirelessTarget, () => hdmiDisconnect.current());
  const wirelessBlocked = wirelessMode && (!wireless.ready || !display.receiverSupportsPage || !display.receiverSupportsPageAck || !display.receiverRenderedPage || display.status !== 'connected');
  const wirelessStop = useRef(wireless.stop); wirelessStop.current = wireless.stop;
  const savedCamera = useRef('');
  const profile = computerCameraProfile(quality);
  const boundedCapture = quality !== '1080p' && quality !== '4k';
  // Drivers may return a larger native mode than the requested ideal dimensions.
  const cameraTransform = useMemo(() => rotation === 0 && !boundedCapture ? undefined
    : (source: MediaStream, signal: AbortSignal) => orientExhibitionCamera(source, rotation, signal, { width: profile.width, height: profile.height }), [rotation, profile, boundedCapture]);
  const quarterTurn = rotation === 90 || rotation === 270;
  const cameraCaptureDimensions = useMemo(() => quality === '4k' || quarterTurn
    ? { width: profile.width, height: profile.height }
    : boundedCapture ? { width: profile.height, height: profile.width } : undefined, [quarterTurn, profile, quality, boundedCapture]);
  const waiting = state?.phase === 'idle' || state?.phase === 'select';
  const startScreen = waiting || state?.phase === 'paused';
  const live = useExhibitionLive({ state, active: !!display.session, mirrorId, refresh,
    terminal: display.session ? { terminalId: display.session.terminalId, token: display.session.token } : undefined,
    cameraPreferenceScope, cameraTransform, cameraCaptureDimensions, waitForCameraRelease: retry.replaceHost, selectionPending: controller.selectionPending,
    // Opening an existing generating round must never allocate a cloud session.
    cameraSettingsOpen: receiverExpired || ((!armed || hdmiBlocked || wirelessBlocked) && !startScreen),
  });
  const latest = useRef({ live, controller }); latest.current = { live, controller };
  hdmiDisconnect.current = async () => {
    setArmed(false);
    if (!pageActive.current || (!display.session && !(wirelessMode && wirelessOwnedHost.current))) return true;
    const current = latest.current;
    const results = await Promise.allSettled([current.live.stopGeneration(), current.controller.stopExperience()]);
    return results.every(result => result.status === 'fulfilled' && result.value === true);
  };

  useEffect(() => {
    document.title = wirelessMode ? 'OpenBuy.AI · 无线投屏' : hdmiMode ? 'OpenBuy.AI · HDMI 大屏' : browserOutput ? 'OpenBuy.AI · 网页大屏' : 'OpenBuy.AI · 电脑视频源';
  }, [hdmiMode, browserOutput, wirelessMode]);

  useEffect(() => {
    if (wirelessMode && (wireless.stream || wireless.busy) && (!display.session || !display.receiverOnline
      || !display.receiverSupportsPage || !display.receiverSupportsPageAck)) void wirelessStop.current('连接已断开，请重新投屏。');
  }, [wirelessMode, wireless.stream, wireless.busy, display.session, display.receiverOnline, display.receiverSupportsPage, display.receiverSupportsPageAck, display.status]);

  useEffect(() => {
    let disposed = false;
    pageActive.current = true;
    wirelessOwnedHost.current = false;
    setDisplay(initialDisplay); setArmed(false); setReceiverExpired(false); setStats(null);
    setStoppingForConnection(false); setConnectionError('');
    const transport = new ComputerDisplaySender(mirrorId, live.deviceId, {
      change: next => {
        if (disposed) return;
        if (wirelessMode && next.session) wirelessOwnedHost.current = true;
        setDisplay(next);
        if (!next.session) {
          setArmed(false);
          if (next.status === 'error') {
            const current = latest.current;
            if (current.controller.state?.live?.deviceId === current.live.deviceId) {
              void Promise.allSettled([current.live.stopGeneration(), current.controller.stopExperience()]);
            }
          }
        }
      },
      receiverExpired: () => {
        if (disposed || browserOutput) return;
        setReceiverExpired(true); setArmed(false);
        const current = latest.current;
        if (current.controller.state?.live || ['generating', 'showcase', 'paused', 'positioning'].includes(current.controller.state?.phase ?? '')) {
          void Promise.allSettled([current.live.stopGeneration(), current.controller.stopExperience()]);
        }
      },
      connectionLost: () => { if (!disposed && wirelessMode) void wirelessStop.current('视频连接已断开，请重新投屏。'); },
      stats: next => { if (!disposed) setStats(next); },
      qualityError: message => { if (!disposed) setOutputError(message); },
    }, {}, outputTarget);
    sender.current = transport;
    // StrictMode's discarded setup must not open a second delegated host session.
    void Promise.resolve().then(() => { if (!disposed) void transport.start({ waitForRelease: retry.waitForRelease, replaceHost: retry.replaceHost }); });
    const leave = () => { pageActive.current = false; takeover.current = null; transport.close(); };
    window.addEventListener('pagehide', leave);
    return () => { disposed = true; pageActive.current = false; takeover.current = null; window.removeEventListener('pagehide', leave); transport.close(); if (sender.current === transport) sender.current = null; };
  }, [mirrorId, live.deviceId, retry, outputTarget, browserOutput, wirelessMode]);

  useEffect(() => {
    if (!pageActive.current || !display.session || live.opening || live.cameraError) return;
    const track = (live.rawCameraStream ?? live.cameraStream)?.getVideoTracks?.().find(item => item.readyState === 'live');
    if (!track) return;
    try {
      const deviceId = track.getSettings().deviceId;
      // Persist only the successful, currently selected capture, never a requested
      // device ID or a previous track while another camera grant is in flight.
      if (!deviceId || deviceId !== live.selectedCameraId) return;
      const label = live.cameras.find(camera => camera.deviceId === deviceId)?.label || track.label || '';
      const preference = { deviceId, label, profile: 'screen' as const };
      const key = JSON.stringify([cameraPreferenceScope, preference]);
      if (key === savedCamera.current) return;
      saveCameraPreference(preference, cameraPreferenceScope);
      savedCamera.current = key;
    } catch { /* Unavailable device metadata or storage must not interrupt capture. */ }
  }, [cameraPreferenceScope, display.session, live.cameraStream, live.rawCameraStream, live.selectedCameraId, live.cameras, live.opening, live.cameraError]);

  useEffect(() => {
    if (!hdmiBlocked && !wirelessBlocked && display.session && startScreen && !state?.live && (browserOutput || !receiverExpired || display.receiverOnline)) {
      setArmed(true); setReceiverExpired(false);
    }
  }, [display.session, display.receiverOnline, startScreen, state?.live, receiverExpired, browserOutput, hdmiBlocked, wirelessBlocked]);

  const showImage = state?.providerMode !== 'xmax' || (state?.experienceMode === 'mox' && (!live.outputStream || live.presentation?.showInputImage));
  const output = !startScreen && !live.error && !showImage ? live.outputStream : null;
  // This receiver decodes landscape 4K in hardware. Keep full-resolution LAN
  // camera video landscape and rotate at display; local/gesture/cloud use cameraStream.
  const sendRawCamera = !browserOutput && !wirelessMode && quality === '4k' && quarterTurn;
  const stream = wirelessMode ? wireless.stream : showImage ? null : output ?? (sendRawCamera ? live.rawCameraStream ?? null : live.cameraStream);
  const source = wirelessMode ? 'page' : showImage ? 'image' : output ? 'output' : 'camera';
  // WebRTC carries source pixels, not the browser's display transform. Match
  // Kiosk's camera/live output orientation; MoX and captured pages are already oriented.
  const mirrored = (source === 'camera' || (source === 'output' && state?.experienceMode !== 'mox')) && live.mirrored;
  const displayRotation = source === 'camera' && sendRawCamera ? rotation : 0;
  useEffect(() => {
    void sender.current?.setSource(stream, { source, mirrored, ...(displayRotation ? { rotation: displayRotation } : {}) }).catch(() => undefined);
  }, [stream, source, mirrored, displayRotation, display.session]);
  useEffect(() => {
    const transport = sender.current;
    if (!transport || browserOutput) return;
    let disposed = false;
    const current = () => !disposed && pageActive.current && sender.current === transport;
    setOutputPending(!!display.session);
    void transport.setQuality(outputSettings.quality, outputSettings.frameRate).then(() => {
      if (!current() || !display.session) return;
      setOutputError('');
      if (outputSettings.edited) {
        try { scopedLocalStorage.setItem(outputKey(outputPreferenceScope), JSON.stringify({ quality: outputSettings.quality, frameRate: outputSettings.frameRate })); }
        catch { setCameraSettingsError('输出设置未能保存。'); }
      }
    }, () => { if (current()) setOutputError('输出设置未生效，请重试。'); })
      .finally(() => { if (current()) setOutputPending(false); });
    return () => { disposed = true; };
  }, [outputSettings, outputRetry, display.session, outputPreferenceScope, browserOutput]);

  const canControl = !hdmiBlocked && !wirelessBlocked && !!display.session && (browserOutput || display.receiverOnline) && armed && !receiverExpired;
  const canConfigure = !!display.session && waiting && !state?.live && !controller.pending && !controller.stopPending && !live.opening;
  const canConfigureOutput = !!display.session && !browserOutput && !outputPending && !controller.stopPending;
  const changeOutputQuality = (value: string) => {
    if (!canConfigureOutput || !isComputerResolution(value) || (wirelessMode && !['1080p', 'l1', 'l2', 'l3', 'l4'].includes(value))) return;
    setOutputError(''); setStats(null);
    setOutputSettings(previous => ({ ...previous, quality: value as ComputerDisplayQuality, edited: true }));
  };
  const changeOutputFrameRate = (value: string) => {
    if (!canConfigureOutput || !['15', '24', '30'].includes(value)) return;
    setOutputError(''); setStats(null);
    setOutputSettings(previous => ({ ...previous, frameRate: Number(value) as ComputerDisplayFrameRate, edited: true }));
  };
  const changeRotation = (value: string) => {
    if (!canConfigure) return;
    const next = Number(value);
    if (next !== 0 && next !== 90 && next !== 180 && next !== 270) return;
    setCameraSettingsError(''); setRotation(next);
    try { scopedLocalStorage.setItem(rotationKey(cameraPreferenceScope), String(next)); }
    catch { setCameraSettingsError('摄像头方向未能保存。'); }
  };
  const changeQuality = (value: string) => {
    if (!canConfigure || !isComputerCameraResolution(value)) return;
    setCameraSettingsError(''); setQuality(value); setStats(null);
    try {
      // Freeze the legacy output default before changing its former capture preference.
      if (!scopedLocalStorage.getItem(outputKey(cameraPreferenceScope))) {
        const previous = savedOutput(cameraPreferenceScope);
        scopedLocalStorage.setItem(outputKey(cameraPreferenceScope), JSON.stringify({ quality: previous.quality, frameRate: previous.frameRate }));
      }
      scopedLocalStorage.setItem(qualityKey(cameraPreferenceScope), value);
    }
    catch { setCameraSettingsError('画质未能保存。'); }
  };
  const fullScreen = async () => {
    try { await document.documentElement.requestFullscreen(); setFullError(''); }
    catch { setFullError('当前浏览器不支持一键全屏，请使用浏览器的全屏功能。'); }
  };
  const mirrorBusy = !display.session && display.errorCode === 'DISPLAY_MIRROR_BUSY';
  const hostBusy = !display.session && display.errorCode === 'DISPLAY_HOST_BUSY';
  const releasing = display.status === 'releasing';
  const stopAndConnect = async () => {
    const transport = sender.current;
    if (!mirrorBusy || !transport || !pageActive.current || takeover.current || controller.stopPending) return;
    const operation = { transport };
    takeover.current = operation; setStoppingForConnection(true); setConnectionError('');
    const current = () => pageActive.current && takeover.current === operation && sender.current === transport;
    try {
      const stopped = await controller.stopExperience();
      if (!current()) return;
      if (!stopped) { setConnectionError('停止未完成，请重试。'); return; }
      // The display endpoint remains the authority: it checks backend session
      // cleanup before granting a host, including locally ended unknown sessions.
      setRetry(value => ({ attempt: value.attempt + 1, waitForRelease: true, replaceHost: true }));
    } catch {
      if (current()) setConnectionError('停止未完成，请重试。');
    } finally {
      if (current()) { takeover.current = null; setStoppingForConnection(false); }
    }
  };
  const notice = stoppingForConnection ? '正在停止当前体验…' : releasing ? '正在等待体验结束…'
    : connectionError || display.error || controller.error || cameraSettingsError || (!cameraSettings && outputError) || fullError;
  if (!state) return <main className="ex-app ex-connection-screen"><Monitor size={36} /><h1>{wirelessMode ? '无线投屏' : browserOutput ? '网页大屏' : '电脑视频源'}</h1><p>{controller.error || '正在连接后台…'}</p><button className="ex-button" onClick={() => void refresh()}>重新连接</button></main>;
  const kiosk = <Kiosk state={state} send={controller.send} stopExperience={controller.stopExperience} stopPending={controller.stopPending}
    commandPending={controller.pending} selectionPending={controller.selectionPending} canControl={canControl}
    disabled={!canControl || !connected || (controller.pending && !controller.selectionPending) || controller.stopPending}
    live={live} cameraControl={<div className="ex-terminal-camera-entry"><button type="button" aria-label="电脑摄像头"
      aria-expanded={cameraSettings} aria-controls="ex-computer-camera-settings" onClick={() => setCameraSettings(value => !value)}><Monitor size={18} aria-hidden="true" /></button></div>} />;
  const wirelessStatus = wireless.stopping ? '正在停止体验…' : !display.session ? displayLabels[display.status]
    : !display.receiverOnline ? '等待安卓上线 · 视频来源选择「局域网电脑」'
    : !display.receiverSupportsPage || !display.receiverSupportsPageAck ? '请更新安卓 App 后重试'
    : display.status !== 'connected' ? '正在连接安卓大屏…'
    : !connected ? '后台连接中断，正在重连…'
    : wireless.ready ? display.receiverRenderedPage ? '正在投屏' : '等待安卓显示画面…'
    : '选择当前试衣标签页，安卓显示完整界面';
  return <main className={`ex-app ex-screen-page${wirelessMode ? ' ex-wireless-page' : ''}`} data-presentation={wirelessMode ? 'wireless' : hdmiMode ? 'hdmi' : undefined} data-display-output={outputTarget} data-display-state={display.status} data-display-source={source} data-camera-rotation={rotation} data-camera-quality={quality}
    data-display-quality={outputSettings.quality} data-display-frame-rate-limit={outputSettings.frameRate}
    data-display-page-rendered={wirelessMode ? !!display.receiverRenderedPage : undefined}
    data-display-fps={stats?.framesPerSecond} data-display-width={stats?.width} data-display-height={stats?.height}
    data-display-bitrate={stats?.bitrate} data-display-codec={stats?.codec} data-display-codec-fmtp={stats?.codecFmtpLine}
    data-display-source-width={stats?.sourceWidth} data-display-source-height={stats?.sourceHeight} data-display-source-fps={stats?.sourceFps}
    data-display-quality-limitation-reason={stats?.qualityLimitationReason} data-display-encode-ms-per-frame={stats?.encodeMsPerFrame}
    data-display-available-outgoing-bitrate={stats?.availableOutgoingBitrate} data-display-encoder-implementation={stats?.encoderImplementation}
    data-display-power-efficient-encoder={stats?.powerEfficientEncoder} data-display-fraction-lost={stats?.fractionLost} data-display-round-trip-time={stats?.roundTripTime}>
    {wirelessMode ? <>
      <header className="ex-wireless-toolbar"><div><strong><Cast size={18} />无线投屏</strong><span role="status">{wirelessStatus}</span></div>
        <div className="ex-wireless-actions">
          {wireless.message && <p role="status" className="ex-field-error">{wireless.message}</p>}
          {wireless.needsStop ? <button aria-label="重试停止" className="ex-button" disabled={wireless.stopping} onClick={() => void wireless.retryStop()}>重试停止</button>
            : wireless.stream || wireless.busy ? <button aria-label="停止投屏" className="ex-button" onClick={() => void wireless.stop()}><Square size={16} />停止投屏</button>
              : <button aria-label="共享试衣界面" className="ex-button ex-primary" disabled={!display.session || !display.receiverOnline || !display.receiverSupportsPage || !display.receiverSupportsPageAck}
                onClick={() => void wireless.start()}><Cast size={16} />共享试衣界面</button>}
        </div>
      </header>
      <div className="ex-wireless-stage" ref={wirelessTarget}>{kiosk}</div>
    </> : kiosk}
    {!wirelessMode && <div className="ex-preview-connection" role="status" style={{ position: 'fixed', top: 12, left: 16 }}><i className={display.status === 'connected' ? 'is-online' : ''} />{browserOutput && display.status === 'connected' ? hdmiMode ? 'HDMI 大屏' : '网页大屏' : displayLabels[display.status]}</div>}
    {hdmiMode ? <HdmiDisplayPanel presentation={hdmi} /> : browserOutput && <button className="ex-fullscreen" aria-label="进入全屏" onClick={() => void fullScreen()}><Maximize2 size={16} /></button>}
    {cameraSettings && <section id="ex-computer-camera-settings" className="ex-camera-panel" style={{ position: 'fixed', zIndex: 65, right: 16, top: 16, width: 'min(520px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 32px)', overflow: 'auto' }}>
      <button type="button" className="ex-icon-button" aria-label="关闭电脑摄像头设置" onClick={() => setCameraSettings(false)}><X size={18} /></button>
      <LiveCameraPanel live={live} mirrorId={mirrorId} compact />
      <label className="ex-camera-select">摄像头画质<select aria-label="摄像头画质" value={quality} disabled={!canConfigure} onChange={event => changeQuality(event.target.value)}>
        {CAMERA_RESOLUTION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
      <label className="ex-camera-select">摄像头方向<select aria-label="摄像头方向" value={rotation} disabled={!canConfigure} onChange={event => changeRotation(event.target.value)}><option value={0}>默认</option><option value={90}>顺时针 90°</option><option value={180}>180°</option><option value={270}>逆时针 90°</option></select></label>
      {!browserOutput && <section className="ex-display-settings" aria-label="安卓大屏输出">
        <strong>安卓大屏输出</strong>
        <div className="ex-camera-controls">
          <label className="ex-camera-select">输出分辨率<select aria-label="输出分辨率" value={outputSettings.quality} disabled={!canConfigureOutput} onChange={event => changeOutputQuality(event.target.value)}>
            {COMPUTER_RESOLUTION_OPTIONS.filter(option => !wirelessMode || ['1080p', 'l1', 'l2', 'l3', 'l4'].includes(option.value)).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select></label>
          <label className="ex-camera-select">帧率上限<select aria-label="帧率上限" value={outputSettings.frameRate} disabled={!canConfigureOutput} onChange={event => changeOutputFrameRate(event.target.value)}>
            <option value={15}>15 帧/秒</option><option value={24}>24 帧/秒</option><option value={30}>30 帧/秒</option>
          </select></label>
        </div>
        <div role="status" aria-label="发送到大屏">发送到大屏 · {source === 'page' ? '完整试衣界面' : source === 'camera' ? '摄像头画面' : source === 'output' ? '生成画面' : '素材画面'} {stream && stats && stats.width > 0 && stats.height > 0 ? `${stats.width} × ${stats.height} · ${stats.framesPerSecond.toFixed(1)} fps` : '—'}</div>
        {outputError && <div className="ex-camera-error" role="alert">{outputError}<button type="button" disabled={!canConfigureOutput} onClick={() => setOutputRetry(value => value + 1)}>重试应用</button></div>}
      </section>}
    </section>}
    {notice && <div className="ex-toast" role={stoppingForConnection || releasing ? 'status' : 'alert'}><span>{notice}</span>{!display.session && <button type="button"
      disabled={stoppingForConnection || releasing || controller.stopPending}
      onClick={() => { if (mirrorBusy) void stopAndConnect(); else setRetry(value => ({ attempt: value.attempt + 1, waitForRelease: false, replaceHost: hostBusy })); }}>
      {mirrorBusy ? <Square size={16} /> : <RotateCcw size={16} />}{stoppingForConnection ? '正在停止…' : releasing ? '正在连接…' : mirrorBusy ? '停止并连接' : hostBusy ? '接管连接' : '重新连接'}
    </button>}{display.session && outputError && !cameraSettings && <button type="button" onClick={() => setCameraSettings(true)}>输出设置</button>}</div>}
  </main>;
}
