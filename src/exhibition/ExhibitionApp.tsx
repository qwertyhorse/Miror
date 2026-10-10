import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, Link2, Maximize2, Monitor, Play, RotateCcw, Sparkles, Square, WifiOff, X } from 'lucide-react';
import { EXHIBITION_MODE_LABELS, isExhibitionLocallyEnded, type ExhibitionCommand, type ExhibitionState, type ExhibitionMirrorSummary } from '../../shared/exhibition';
import { appUrl } from '../versionScope';
import { enabledLooksForMode, phaseLabel } from './catalog';
import { MirrorConsole } from './MirrorConsole';
import { useMirrors, type MirrorRegistry } from './useMirrors';
import { exhibitionUrl } from './mirrorApi';
import { defaultMirrorCameraEntry, exhibitionCameraUrl } from './cameraEntry';
import { useTerminalBinding, type TerminalBinding } from './useTerminalBinding';
import { TerminalPairingScreen } from './TerminalPairingScreen';
import { useExhibitionLive, type ExhibitionLiveController } from './useExhibitionLive';
import { StreamVideo } from './LiveCameraPanel';
import { useExhibition, type ExhibitionController } from './useExhibition';
import { MirrorMaterialDrawer } from './MirrorMaterialDrawer';
import { MoXDragSurface } from './MoXDragSurface';
import { MirrorCredentialSettings } from './MirrorCredentialSettings';
import { mirrorSkin } from './uiSkins';
import './exhibition.css';
import './mirror-console.css';
import './terminal-pairing.css';
import './mirror-screen.css';

function Brand() {
  return <span className="ex-brand"><img src={appUrl('/assets/exhibition/openbuy-ai-logo-rgb.png')} alt="OpenBuyAI" /></span>;
}

export function Kiosk({ state, send, disabled = false, passive = false, live, stopExperience, stopPending = false, commandPending = false, canControl = true, presentation = 'terminal' }: {
  state: ExhibitionState; send?: ExhibitionController['send']; disabled?: boolean; passive?: boolean; live?: ExhibitionLiveController;
  stopExperience?: ExhibitionController['stopExperience']; stopPending?: boolean; commandPending?: boolean; canControl?: boolean;
  presentation?: 'terminal' | 'remote';
}) {
  const remote = presentation === 'remote';
  const kioskLabel = passive ? '镜端状态预览' : remote ? '镜端远程控制' : 'AI 试衣镜';
  const enabled = enabledLooksForMode(state);
  const look = enabled.find(item => item.id === state.selectedLookId);
  const shown = enabled.find(item => item.id === (state.displayedLookId ?? state.selectedLookId)) ?? look;
  const welcome = state.phase === 'idle' || state.phase === 'select';
  const locallyEnded = isExhibitionLocallyEnded(state);
  const loading = state.phase === 'generating' || state.phase === 'positioning';
  const paused = state.phase === 'paused';
  const [carouselBusy, setCarouselBusy] = useState(false);
  const [beginPending, setBeginPending] = useState(false);
  const [beginError, setBeginError] = useState('');
  const [localStopPending, setLocalStopPending] = useState(false);
  const starting = useRef(false);
  const beginIntent = useRef(0);
  const stopping = useRef(false);
  const currentRound = useRef({ state, disabled, passive });
  currentRound.current = { state, disabled, passive };
  const visualLook = loading || paused ? look : shown;
  const mode = state.experienceMode ?? 'clothx';
  const mox = mode === 'mox';
  const realtime = state.providerMode === 'xmax';
  useEffect(() => { setBeginError(''); }, [state.phase, state.providerMode, state.experienceMode, state.selectedLookId, state.sessionNumber, state.generationNumber]);
  const otherDevice = remote || (!!state.live && !!live && state.live.deviceId !== live.deviceId);
  const stream = otherDevice ? null : live?.outputStream ?? live?.cameraStream ?? null;
  const serverError = state.live?.status === 'error';
  const needsRetry = realtime && !welcome && !passive && !otherDevice && (!!live?.error || serverError);
  const localView = realtime && !passive && !otherDevice && !needsRetry;
  const showingInputImage = mox && (!live?.outputStream || live.presentation?.showInputImage);
  // A stream can precede its first frame or belong to the round being replaced.
  const visualSource = !localView || welcome ? null : showingInputImage ? '素材预览'
    : live?.outputStream ? live.status === 'running' && state.phase === 'showcase' ? '生成结果' : null
      : null;
  const generationPending = localView && state.phase === 'generating' && live?.status !== 'stopping' && live?.status !== 'error';
  const preparationLabel = live?.status === 'opening' ? '开启摄像头'
    : live?.status === 'preparing' ? '准备素材'
      : live?.status === 'connecting' || live?.status === 'running' ? '等待生成画面' : '等待连接';
  const outputLabel = visualSource === '生成结果' ? '生成结果' : paused ? '已暂停的生成画面' : showingInputImage ? '素材预览' : '生成画面准备中';
  const livePlaceholder = passive || otherDevice ? '镜端正在体验' : serverError ? '连接暂未恢复' : needsRetry ? '画面暂未连接' : paused ? '已暂停' : '正在连接';
  const skinStyle = state.settings.uiSkin ? { backgroundImage: `url(${appUrl(state.settings.uiSkin.image)})` } : undefined;
  const skin = mirrorSkin(state);
  const command = async (input: ExhibitionCommand) => {
    if (passive || !canControl || !send) return false;
    if (input.action === 'end' || input.action === 'idle') {
      if (stopping.current || stopPending) return false;
      stopping.current = true; ++beginIntent.current; starting.current = false;
      setBeginPending(false); setBeginError(''); setLocalStopPending(true);
      try {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => live?.stopGeneration?.() ?? true),
          Promise.resolve().then(() => input.action === 'end' && stopExperience ? stopExperience() : send(input)),
        ]);
        const confirmed = results.every(result => result.status === 'fulfilled' && result.value !== false);
        if (!confirmed) setBeginError('停止状态未确认，请联系工作人员。');
        return confirmed;
      } finally { stopping.current = false; setLocalStopPending(false); }
    }
    if (disabled || localStopPending || stopPending) return false;
    if (input.action === 'recover' && (!locallyEnded || commandPending)) return false;
    if (input.action === 'begin' && realtime && !remote) {
      if (starting.current || live?.opening || state.live || !welcome) return false;
      setBeginError('');
      if (!live) { setBeginError('实时连接尚未准备好，请稍后重试。'); return false; }
      if (!mox && !live.secure) { setBeginError('摄像头连接不可用，请重新打开镜端。'); return false; }
      if (live.liveStatus?.configured === false) { setBeginError('XMAX 尚未配置，请联系工作人员。'); return false; }
      starting.current = true;
      const intent = ++beginIntent.current;
      setBeginPending(true);
      try {
        if (!mox && !live.cameraStream && !(await live.startCamera())) return false;
        const latest = currentRound.current;
        if (intent !== beginIntent.current || latest.disabled || latest.passive || !['idle', 'select'].includes(latest.state.phase) || latest.state.live
          || latest.state.providerMode !== state.providerMode || latest.state.experienceMode !== state.experienceMode
          || latest.state.sessionNumber !== state.sessionNumber || latest.state.generationNumber !== state.generationNumber
          || latest.state.selectedLookId !== state.selectedLookId) return false;
        return await send(input);
      } finally { if (intent === beginIntent.current) { starting.current = false; setBeginPending(false); } }
    }
    return send(input);
  };
  const retryExperience = async () => {
    if (passive || disabled || !live || live.opening || serverError) return;
    if (((!mox && !live.cameraStream) || live.error) && !(await live.retry())) return;
    const latest = currentRound.current;
    if (!latest.disabled && !latest.passive && latest.state.phase === 'paused'
      && latest.state.sessionNumber === state.sessionNumber && latest.state.generationNumber === state.generationNumber
      && latest.state.selectedLookId === state.selectedLookId) void command({ action: 'resume' });
  };
  const hasStop = !welcome || (!!state.live && !locallyEnded) || beginPending || commandPending || stopPending || localStopPending;
  const stopButton = hasStop ? <button type="button" className="ex-kiosk-primary ex-kiosk-stop" disabled={passive || !canControl || !send || stopPending || localStopPending} onClick={() => void command({ action: 'end' })}><Square fill="currentColor" />{stopPending || localStopPending ? '正在停止…' : '停止生成'}</button> : null;
  const recoveryButton = locallyEnded ? <button type="button" className="ex-kiosk-primary" disabled={disabled || passive || !canControl || !send || commandPending || stopPending || localStopPending} onClick={() => void command({ action: 'recover' })}><RotateCcw />{commandPending ? '恢复中…' : '恢复操作'}</button> : null;
  if (!look || !visualLook || !enabled.length) return <section className="ex-kiosk ex-mirror-minimal ex-empty-mode" style={skinStyle} aria-label={passive ? '镜端状态预览' : presentation === 'terminal' ? '智能镜大屏' : kioskLabel} data-mode={EXHIBITION_MODE_LABELS[mode]} data-skin={skin}>
    <header className="ex-mirror-brand"><Brand /></header>
    <div className="ex-mirror-stage ex-mirror-empty"><Sparkles aria-hidden="true" /><span>暂无可用素材</span><div className="ex-mirror-stage-actions">{recoveryButton ?? stopButton ?? <button className="ex-kiosk-primary" disabled><Play fill="currentColor" />开始体验</button>}</div></div>
  </section>;
  const canChoose = !disabled && !localStopPending && !stopPending && !beginPending && !needsRetry && !live?.opening && ((welcome && !state.live) || (state.phase === 'showcase' && state.live?.status !== 'stopping' && state.live?.status !== 'error'));
  const feedback = !locallyEnded && !passive && !otherDevice ? beginError || (realtime ? live?.error || (serverError ? '换装连接状态未确认，请联系工作人员。' : '') : '') : '';
  return <section className={`ex-kiosk ex-mirror-minimal ex-phase-${state.phase}${welcome ? ' ex-welcome' : ''}${passive ? ' ex-passive' : ''}`} style={skinStyle} aria-label={kioskLabel} data-mode={EXHIBITION_MODE_LABELS[mode]} data-skin={skin}>
    <header className="ex-mirror-brand"><Brand /></header>
    <div className="ex-mirror-stage">
      {welcome ? (live?.cameraStream && !passive && !otherDevice && !mox ? <StreamVideo stream={live.cameraStream} mirrored={live?.mirrored} label="本地取景" /> : <img className="ex-mirror-poster" src={appUrl(visualLook.image)} alt={visualLook.name} />)
        : realtime && mox && !passive && !otherDevice && !needsRetry ? <MoXDragSurface interaction={live?.interaction ?? null} disabled={disabled || paused || !live?.interaction} imageUrl={!live?.outputStream || live?.presentation?.showInputImage ? live?.presentation?.inputImageUrl ?? appUrl(visualLook.image) : undefined}>
          {live?.outputStream && <StreamVideo stream={live.outputStream} mirrored={false} label={outputLabel} onFirstFrame={live.reportFirstFrame} />}
        </MoXDragSurface> : realtime ? (stream && !passive && !needsRetry ? <StreamVideo key={live?.outputStream ? 'output' : 'camera'} stream={stream} mirrored={live?.mirrored} label={live?.outputStream ? outputLabel : '本地取景'} onFirstFrame={live?.outputStream ? live.reportFirstFrame : undefined} /> : <div className="ex-mirror-placeholder"><Sparkles aria-hidden="true" /><span>{livePlaceholder}</span>{passive ? <small>仅同步状态，未回传镜端视频</small> : otherDevice ? <small>当前页面未接收镜端视频</small> : needsRetry && !serverError && <button type="button" className="ex-kiosk-retry" disabled={disabled || live?.opening} onClick={() => void retryExperience()}><RotateCcw />重试</button>}</div>) : <img className="ex-mirror-poster" src={appUrl(visualLook.image)} alt={`${visualLook.name}素材预览`} />}
      {localView && (visualSource || generationPending) && <div className="ex-visual-status" role="status" aria-live="polite">
        {visualSource && <span>{visualSource}</span>}
        {generationPending && <span className="ex-visual-generating"><Sparkles aria-hidden="true" />{preparationLabel}</span>}
      </div>}
      {!realtime && loading && <div className="ex-visual-status" role="status"><span>正在生成</span></div>}
      <MirrorMaterialDrawer key={mode} looks={enabled} selectedId={state.selectedLookId} disabled={!canChoose} passive={passive}
        title={mode === 'clothx' ? '选择服装' : '选择素材'} onBusyChange={setCarouselBusy} onSelect={lookId => {
          const latest = currentRound.current;
          if (latest.disabled || latest.passive) return Promise.resolve(false);
          if (latest.state.phase === 'idle' || latest.state.phase === 'select') return command({ action: 'select', lookId });
          if (latest.state.phase === 'showcase') return command({ action: 'switch', lookId });
          return Promise.resolve(false);
        }} />
      {feedback && <div className="ex-mirror-feedback" role="alert"><span>{feedback}</span>{welcome && realtime && !mox && live?.secure && live.error && !state.live && <><button type="button" className="ex-kiosk-retry" disabled={disabled || live.opening} onClick={() => { setBeginError(''); void live.startCamera(); }}><RotateCcw aria-hidden="true" />重试摄像头</button><a className="ex-kiosk-retry" href={appUrl(`/camera-check.html?mirror=${encodeURIComponent(state.mirrorId ?? 'default')}`)}>选择摄像头</a></>}</div>}
      {locallyEnded && !passive && <div className="ex-mirror-feedback" role="status"><span>本地体验已结束，云端凭证状态待确认。</span></div>}
      <div className="ex-mirror-stage-actions">
        {recoveryButton ?? stopButton ?? <button className="ex-kiosk-primary" disabled={disabled || passive || carouselBusy || beginPending || live?.opening || !!state.live} onClick={() => void command({ action: 'begin' })}><Play fill="currentColor" />{beginPending || live?.opening ? '等待摄像头…' : '开始体验'}</button>}
        {paused && !state.live && !stopPending && !localStopPending && <button className="ex-kiosk-continue" disabled={disabled || passive || live?.opening} onClick={() => { if (realtime && !remote) void retryExperience(); else void command({ action: 'resume' }); }}><Play fill="currentColor" />继续体验</button>}
      </div>
    </div>
    <footer className="ex-mirror-footer">
      {!welcome && <button type="button" className="ex-mirror-home" aria-label="返回首页" disabled={passive || !canControl || stopPending || localStopPending} onClick={() => void command({ action: 'idle' })}><ArrowLeft /></button>}
    </footer>
  </section>;
}

type MirrorPreviewController = Pick<ExhibitionController, 'send' | 'stopExperience' | 'pending' | 'stopPending' | 'connected'>;

export function MirrorPreview({ state, controller }: { state: ExhibitionState; controller: MirrorPreviewController }) {
  return <section className="ex-monitor-preview ex-interactive-preview ex-preview-remote" aria-label="镜端预览">
    <div className="ex-subheading">镜端预览</div>
    <div className="ex-preview-connection" role="status"><i className={controller.connected ? 'is-online' : ''} />{controller.connected ? '状态已同步' : '连接已断开'}<span>{EXHIBITION_MODE_LABELS[state.experienceMode]}</span></div>
    <Kiosk state={state} send={controller.send} stopExperience={controller.stopExperience} stopPending={controller.stopPending}
      commandPending={controller.pending} disabled={controller.pending || controller.stopPending || !controller.connected} presentation="remote" />
  </section>;
}

function MirrorPage({ mirror, registry, selectMirror, terminal }: { mirror: ExhibitionMirrorSummary; registry: MirrorRegistry; selectMirror: (id: string) => void; terminal?: TerminalBinding }) {
  const mirrorId = mirror.id;
  const controller = useExhibition(mirrorId);
  const { state, connected, pending, error, clearError, refresh } = controller;
  const path = window.location.pathname.replace(/\/$/, '');
  const screen = path.endsWith('/screen');
  const control = !screen;
  const ownsMirror = !mirror.binding || (!!terminal?.connected && terminal.connection?.mirrorId === mirror.id && terminal.identity?.terminalId === mirror.binding.terminalId);
  const live = useExhibitionLive({ state, active: !control && ownsMirror, refresh, mirrorId, terminal: terminal?.connected && terminal.connection?.mirrorId === mirror.id ? terminal.identity ?? undefined : undefined });
  const [fullError, setFullError] = useState('');
  useEffect(() => { document.title = screen ? 'OpenBuy.AI · 轻触试衣镜' : 'OpenBuy.AI · 展会控制台'; }, [screen]);
  const fullScreen = async () => {
    try { await document.documentElement.requestFullscreen(); }
    catch { setFullError('当前浏览器不支持一键全屏，请使用浏览器的全屏功能。'); }
  };
  if (new URLSearchParams(window.location.search).get('credentialForm') === '1') return <main className="ex-app ex-credential-embedded-page"><MirrorCredentialSettings embedded controller={controller} live={live} /></main>;
  if (!state) return <main className="ex-app ex-connection-screen"><Brand /><Sparkles size={36} /><h1>连接试衣镜</h1><p>{error || (connected ? '正在准备你的展会页面…' : '正在连接本地后台，请稍候。')}</p><button className="ex-button" onClick={() => void refresh()}>重新连接</button></main>;
  return <main className={`ex-app${screen ? ' ex-screen-page' : ' ex-control-page'}`}>
    {!screen && <header className="ex-topbar"><a href={exhibitionUrl('/exhibition/control', mirrorId)} aria-label="展会后台首页"><Brand /></a><nav aria-label="预览入口"><a href={exhibitionCameraUrl(mirrorId)} target="_blank" rel="noreferrer">竖屏大屏<ExternalLink size={12} /></a><a className={control ? 'is-current' : ''} href={exhibitionUrl('/exhibition/control', mirrorId)}>工作人员后台</a></nav><span className="ex-topbar-badge">{state.providerMode === 'xmax' ? 'XMAX 实时' : '交互演示'}</span></header>}
    {screen ? <><Kiosk state={state} send={controller.send} stopExperience={controller.stopExperience} stopPending={controller.stopPending} commandPending={pending} canControl={ownsMirror} disabled={pending || !connected || !ownsMirror} live={live} />{!terminal?.identity && <button className="ex-terminal-bind-trigger" onClick={terminal?.beginPairing}><Link2 size={14} />绑定设备</button>}{!ownsMirror && <span className="ex-terminal-preview-note">已绑定其他镜端 · 此页仅预览</span>}<button className="ex-fullscreen" aria-label="进入全屏" onClick={() => void fullScreen()}><Maximize2 size={16} /></button></> : <div className="ex-control-container"><MirrorConsole controller={controller} live={live} mirror={mirror} registry={registry} selectMirror={selectMirror} preview={<MirrorPreview key={mirror.id} state={state} controller={controller} />} /></div>}

    {!connected && <div className="ex-connection-alert" role="alert"><WifiOff size={17} /><span>后台连接中断，操作暂不可用。正在重新连接…</span><button onClick={() => void refresh()}>重试</button></div>}
    {(error || fullError) && <div className="ex-toast" role="alert"><span>{error || fullError}</span><button aria-label="关闭提示" onClick={() => { clearError(); setFullError(''); }}><X size={16} /></button></div>}
    <span className="ex-sr-only" role="status" aria-live="polite">{phaseLabel[state.phase]}</span>
  </main>;
}


function ExhibitionContent() {
  const registry = useMirrors();
  const currentPath = window.location.pathname.replace(/\/$/, '');
  const isScreen = currentPath.endsWith('/screen');
  useEffect(() => {
    if (!isScreen && !currentPath.endsWith('/control')) {
      const url = new URL(window.location.href); url.pathname = appUrl('/exhibition/control');
      window.location.replace(url.toString());
    }
  }, [isScreen, currentPath]);
  const terminal = useTerminalBinding(isScreen);
  const [mirrorId, setMirrorId] = useState(() => new URLSearchParams(window.location.search).get('mirror') ?? 'default');
  useEffect(() => {
    const changed = () => setMirrorId(new URLSearchParams(window.location.search).get('mirror') ?? 'default');
    window.addEventListener('popstate', changed);
    return () => window.removeEventListener('popstate', changed);
  }, []);
  const selectMirror = (id: string) => {
    if (id === mirrorId) return;
    const url = new URL(window.location.href);
    url.searchParams.set('mirror', id);
    window.history.pushState(null, '', url);
    setMirrorId(id);
  };
  const boundMirrorId = isScreen && terminal.identity ? terminal.connection?.mirrorId : null;
  useEffect(() => {
    if (!boundMirrorId) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('mirror') !== boundMirrorId) { url.searchParams.set('mirror', boundMirrorId); window.history.replaceState(null, '', url); }
    setMirrorId(boundMirrorId);
  }, [boundMirrorId]);
  if (isScreen && (!terminal.ready || terminal.error || (terminal.identity && (!terminal.connected || !boundMirrorId)))) return <TerminalPairingScreen terminal={terminal} />;
  const selectedMirrorId = boundMirrorId ?? mirrorId;
  const mirror = registry.data?.mirrors.find(item => item.id === selectedMirrorId);
  if (!mirror) return <main className="ex-app ex-connection-screen"><Brand /><Monitor size={36} /><h1>{registry.data ? '设备不存在' : '连接智能镜设备'}</h1><p>{registry.data ? '该设备地址无效，请检查链接中的设备编号。' : registry.error || '正在读取设备列表…'}</p>{registry.data ? <a className="ex-button" href={appUrl('/exhibition/control')}>返回设备后台</a> : <button className="ex-button" onClick={() => void registry.refresh()}>重新连接</button>}</main>;
  // A new tree owns each mirror's drafts, dialogs, requests and camera lease.
  return <MirrorPage key={`${mirror.id}:${isScreen ? terminal.identity?.terminalId ?? 'preview' : 'control'}`} mirror={mirror} registry={registry} selectMirror={selectMirror} terminal={isScreen ? terminal : undefined} />;
}

export default function ExhibitionApp() {
  const cameraEntry = defaultMirrorCameraEntry(window.location.href);
  useEffect(() => { if (cameraEntry) window.location.replace(cameraEntry); }, [cameraEntry]);
  // Do not mount screen clients on the origin we are about to leave.
  return cameraEntry ? null : <ExhibitionContent />;
}
