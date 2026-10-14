import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, Hand, Link2, Maximize2, Monitor, Play, RotateCcw, Sparkles, Square, WifiOff, X } from 'lucide-react';
import { EXHIBITION_MODE_LABELS, isExhibitionLocallyEnded, type ExhibitionCommand, type ExhibitionState, type ExhibitionMirrorSummary } from '../../shared/exhibition';
import { resolveExhibitionGestureSettings, type ExhibitionGestureKind } from '../../shared/exhibitionGestures';
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
import { useExhibitionGestures } from './useExhibitionGestures';
import { usePresenterKeys } from './usePresenterKeys';
import { useExhibition, type ExhibitionController } from './useExhibition';
import { MirrorMaterialDrawer } from './MirrorMaterialDrawer';
import { MoXDragSurface } from './MoXDragSurface';
import { MirrorCredentialSettings } from './MirrorCredentialSettings';
import { mirrorSkin } from './uiSkins';
import { createExhibitionDiagnostics, type DiagnosticEventInput, type ExhibitionDiagnostics } from './diagnostics';
import { diagnosticContext, commandDiagnosticContext, diagnosticsRequested } from './diagnosticContext';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import './exhibition.css';
import './mirror-console.css';
import './terminal-pairing.css';
import './mirror-screen.css';

function Brand() {
  return <span className="ex-brand"><img src={appUrl('/assets/exhibition/openbuy-ai-logo-rgb.png')} alt="OpenBuyAI" /></span>;
}

interface GestureAcknowledgement {
  epoch: number;
  mirrorId: string;
  sessionNumber: number;
  mode: ExhibitionState['experienceMode'];
  revision: number;
  generationNumber: number;
  previousLookId: ExhibitionState['selectedLookId'];
  lookId: string;
  action: 'select' | 'switch';
  label: string;
  showSuccess: boolean;
}

interface PresenterSelection {
  scope: string;
  lookId: string;
  revision: number;
  pending: boolean;
}

function presenterScope(state: ExhibitionState) {
  return `${state.mirrorId ?? 'default'}:${state.sessionNumber}:${state.experienceMode ?? 'clothx'}`;
}

function matchesGestureTarget(ack: GestureAcknowledgement, state: ExhibitionState) {
  const generation = ack.generationNumber + (ack.action === 'switch' ? 1 : 0);
  return (state.mirrorId ?? 'default') === ack.mirrorId && state.sessionNumber === ack.sessionNumber
    && state.experienceMode === ack.mode && ['idle', 'select', 'generating', 'showcase'].includes(state.phase)
    && state.generationNumber >= ack.generationNumber && state.generationNumber <= generation
    && (state.selectedLookId === ack.lookId || (state.selectedLookId === ack.previousLookId && state.revision === ack.revision));
}

export function Kiosk({ state, send, disabled = false, passive = false, live, stopExperience, stopPending = false, commandPending = false, selectionPending = false, canControl = true, presentation = 'terminal', diagnostics = null, sendDiagnosed }: {
  state: ExhibitionState; send?: ExhibitionController['send']; disabled?: boolean; passive?: boolean; live?: ExhibitionLiveController;
  stopExperience?: ExhibitionController['stopExperience']; stopPending?: boolean; commandPending?: boolean; selectionPending?: boolean; canControl?: boolean;
  presentation?: 'terminal' | 'remote'; diagnostics?: ExhibitionDiagnostics | null; sendDiagnosed?: ExhibitionController['sendDiagnosed'];
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
  const [gesturesOn, setGesturesOn] = useState(true);
  const [gestureReset, setGestureReset] = useState(0);
  const [gestureSelection, setGestureSelection] = useState<{ lookId: string; revision: number } | null>(null);
  const [gestureAcknowledgement, setGestureAcknowledgement] = useState<GestureAcknowledgement | null>(null);
  const gestureFeedbackEpoch = useRef(0);
  const gesturePending = useRef(false);
  const presenterTarget = useRef<PresenterSelection | null>(null);
  const [presenterSelection, setPresenterSelection] = useState<PresenterSelection | null>(null);
  const starting = useRef(false);
  const beginIntent = useRef(0);
  const stopping = useRef(false);
  const currentRound = useRef({ state, disabled, passive, canChoose: false });
  currentRound.current = { state, disabled, passive, canChoose: false };
  const visualLook = loading || paused ? look : shown;
  const mode = state.experienceMode ?? 'clothx';
  const mox = mode === 'mox';
  const realtime = state.providerMode === 'xmax';
  useEffect(() => { setBeginError(''); }, [state.phase, state.providerMode, state.experienceMode, state.selectedLookId, state.sessionNumber, state.generationNumber]);
  const otherDevice = remote || (!!state.live && !!live && state.live.deviceId !== live.deviceId);
  const serverError = state.live?.status === 'error' && state.live.generationNumber === state.generationNumber
    && state.live.lookId === state.selectedLookId;
  const needsRetry = realtime && !welcome && !passive && !otherDevice && (!!live?.error || serverError);
  const cameraFallback = needsRetry && !mox && !!live?.cameraStream?.getVideoTracks?.().some(track => track.readyState === 'live');
  const stream = otherDevice ? null : needsRetry ? cameraFallback ? live?.cameraStream ?? null : null : live?.outputStream ?? live?.cameraStream ?? null;
  const localView = realtime && !passive && !otherDevice && !needsRetry;
  const showingInputImage = mox && (!live?.outputStream || live.presentation?.showInputImage);
  // Keep the generated stream visible while its reference condition changes.
  const visualSource = !localView || welcome ? null : showingInputImage ? '素材预览'
    : live?.outputStream ? (live.status === 'running' && state.phase === 'showcase') || (state.live?.status === 'running' && state.phase === 'generating') ? '生成结果' : null
      : null;
  const generationPending = localView && (state.phase === 'generating' || !!state.live?.renewal) && live?.status !== 'stopping' && live?.status !== 'error';
  const preparationLabel = state.live?.renewal ? '正在续接体验' : live?.outputStream && state.live?.status === 'running' ? '正在换装'
    : live?.status === 'opening' ? '开启摄像头'
    : live?.status === 'preparing' ? '准备素材'
      : live?.status === 'connecting' ? '连接实时服务' : live?.status === 'running' ? '等待生成画面' : '等待连接';
  const outputLabel = visualSource === '生成结果' ? '生成结果' : paused ? '已暂停的生成画面' : showingInputImage ? '素材预览' : '生成画面准备中';
  const livePlaceholder = passive || otherDevice ? '镜端正在体验' : serverError ? '连接暂未恢复' : needsRetry ? '画面暂未连接' : paused ? '已暂停' : '正在连接';
  const skinStyle = state.settings.uiSkin ? { backgroundImage: `url(${appUrl(state.settings.uiSkin.image)})` } : undefined;
  const skin = mirrorSkin(state);
  const diagnosticSequence = useRef(0);
  const diagnosticEpoch = useRef(0);
  const sendTraced = async (input: ExhibitionCommand, actionId?: string) => {
    if (!diagnostics || !['select', 'switch', 'begin', 'resume'].includes(input.action)) return send!(input);
    const context = commandDiagnosticContext(currentRound.current.state, input);
    const interactionId = actionId ?? `manual-${++diagnosticSequence.current}`;
    const id = `${interactionId}-attempt-1`;
    const epoch = diagnosticEpoch.current;
    const attemptTimes = new Map<number, number>();
    if (sendDiagnosed) return sendDiagnosed(input, event => {
      if (epoch !== diagnosticEpoch.current) return;
      if (event.type === 'sent') attemptTimes.set(event.attempt, event.at);
      const attemptStart = attemptTimes.get(event.attempt);
      const context = event.type === 'accepted' ? diagnosticContext(event.state) : commandDiagnosticContext(event.state, event.command);
      diagnostics.record({ type: event.type === 'sent' ? 'command_sent' : event.type === 'accepted' ? 'command_accepted'
        : event.type === 'cancelled' ? 'command_cancelled' : 'command_rejected', at: event.at, context,
        interactionId, actionId: `${interactionId}-attempt-${event.attempt}`,
        metrics: { source: actionId ? 'gesture' : 'manual', accepted: event.type === 'accepted',
          ...(event.type !== 'sent' && attemptStart !== undefined ? { durationMs: event.at - attemptStart } : {}) },
        ...(event.type === 'rejected' ? { reason: 'rejected' as const } : event.type === 'cancelled' ? { reason: 'cancelled' as const } : {}) });
    });
    const startedAt = performance.now();
    diagnostics.record({ type: 'command_sent', context, interactionId, actionId: id, at: startedAt, metrics: { source: actionId ? 'gesture' : 'manual' } });
    try {
      const accepted = await send!(input);
      if (epoch === diagnosticEpoch.current) diagnostics.record({ type: accepted ? 'command_accepted' : 'command_rejected', context, interactionId, actionId: id,
        metrics: { accepted, durationMs: performance.now() - startedAt }, ...(accepted ? {} : { reason: 'rejected' as const }) });
      return accepted;
    } catch (error) {
      if (epoch === diagnosticEpoch.current) diagnostics.record({ type: 'command_rejected', context, interactionId, actionId: id, reason: 'rejected', metrics: { durationMs: performance.now() - startedAt } });
      throw error;
    }
  };
  const command = async (input: ExhibitionCommand, actionId?: string) => {
    if (passive || !canControl || !send) return false;
    if (input.action === 'end' || input.action === 'idle') {
      if (stopping.current || stopPending) return false;
      stopping.current = true; ++beginIntent.current; starting.current = false;
      diagnosticEpoch.current++;
      gestureFeedbackEpoch.current++;
      setGestureAcknowledgement(null);
      diagnostics?.observe(diagnosticContext(currentRound.current.state), { active: false });
      setGestureReset(value => value + 1);
      setGestureSelection(null);
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
    if (disabled || stopping.current || localStopPending || stopPending) return false;
    if (input.action === 'begin' && (carouselBusy || commandPending)) return false;
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
        return await sendTraced(input, actionId);
      } finally { if (intent === beginIntent.current) { starting.current = false; setBeginPending(false); } }
    }
    return sendTraced(input, actionId);
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
  const canChoose = !disabled && !passive && canControl && !!send && !localStopPending && !stopPending && !beginPending
    && (!commandPending || selectionPending) && !needsRetry && !serverError && !live?.opening && !state.live?.renewal
    && ((welcome && !state.live) || state.phase === 'generating' || state.phase === 'showcase');
  currentRound.current.canChoose = canChoose;
  const clearPresenterSelection = (target: PresenterSelection) => {
    if (presenterTarget.current !== target) return;
    presenterTarget.current = null;
    setPresenterSelection(null);
  };
  useEffect(() => {
    const target = presenterTarget.current;
    if (target && (target.scope !== presenterScope(state) || paused || locallyEnded || stopPending || localStopPending
      || !enabled.some(item => item.id === target.lookId)
      || (!target.pending && (state.selectedLookId === target.lookId || state.revision > target.revision)))) clearPresenterSelection(target);
  }, [state.mirrorId, state.sessionNumber, mode, state.selectedLookId, state.revision, paused, locallyEnded, stopPending, localStopPending, enabled]);
  usePresenterKeys({
    enabled: !remote && !passive && !otherDevice && canControl && !!send,
    scope: presenterScope(state),
    onStep: direction => {
      const latest = currentRound.current;
      if (!latest.canChoose || carouselBusy || gesturePending.current || gestureSelection || presenterTarget.current
        || starting.current || stopping.current) return;
      const ordered = enabledLooksForMode(latest.state);
      if (ordered.length < 2) return;
      const index = ordered.findIndex(item => item.id === latest.state.selectedLookId);
      const next = ordered[index < 0 ? direction > 0 ? 0 : ordered.length - 1 : (index + direction + ordered.length) % ordered.length];
      const target: PresenterSelection = { scope: presenterScope(latest.state), lookId: next.id, revision: latest.state.revision, pending: true };
      presenterTarget.current = target;
      setPresenterSelection(target);
      // Retain the target until its state is observed, even if the response wins the React render.
      void command({ action: ['idle', 'select'].includes(latest.state.phase) ? 'select' : 'switch', lookId: next.id })
        .then(accepted => {
          target.pending = false;
          const current = currentRound.current.state;
          if (!accepted || target.scope !== presenterScope(current) || current.selectedLookId === target.lookId
            || current.revision > target.revision) clearPresenterSelection(target);
        })
        .catch(() => {
          if (presenterTarget.current !== target) return;
          setBeginError('素材切换未完成，请重试。');
          clearPresenterSelection(target);
        });
    },
  });
  const gestureCamera = !!live?.cameraStream?.getVideoTracks?.().some(track => track.readyState === 'live');
  const recognitionSettings = resolveExhibitionGestureSettings(state.settings.gestureRecognition);
  const configuredGestures = recognitionSettings.gestures;
  const gestureAvailable = realtime && !mox && !remote && !passive && !otherDevice && canControl && !!live?.secure && !locallyEnded && gestureCamera;
  useEffect(() => {
    ++gestureFeedbackEpoch.current;
    setGestureAcknowledgement(null);
    return () => { ++gestureFeedbackEpoch.current; };
  }, [state.mirrorId, state.sessionNumber, mode, gesturesOn, gestureAvailable, disabled, paused, locallyEnded,
    stopPending, localStopPending, needsRetry, serverError, configuredGestures.join(',')]);
  useEffect(() => {
    if (!gestureAcknowledgement?.showSuccess) return;
    const timer = setTimeout(() => setGestureAcknowledgement(current => current === gestureAcknowledgement
      ? { ...current, showSuccess: false } : current), 1200);
    return () => clearTimeout(timer);
  }, [gestureAcknowledgement]);
  const gestureProcessing = gestureSelection !== null || presenterSelection !== null || beginPending || commandPending || selectionPending || !!live?.opening
    || (!welcome && (state.phase === 'generating' || live?.status === 'preparing' || live?.status === 'connecting'));
  const gestureBlocked = !canChoose || carouselBusy || gestureProcessing;
  useEffect(() => {
    // Staff can supersede the target before React observes its selection revision.
    if (!gesturePending.current && gestureSelection && (state.selectedLookId === gestureSelection.lookId
      || state.revision > gestureSelection.revision + 1 || !enabled.some(item => item.id === gestureSelection.lookId)
      || paused || locallyEnded || !gesturesOn)) setGestureSelection(null);
  }, [gestureSelection, state.selectedLookId, state.revision, state.looks, state.enabledLookIds, mode, paused, locallyEnded, gesturesOn]);
  const gestures = useExhibitionGestures({
    stream: live?.cameraStream ?? null, enabled: gesturesOn && gestureAvailable && configuredGestures.length > 0,
    // Blocking boundaries discard old frames while retaining an already-consumed gesture.
    mode: 'palm_wave', mirrored: live?.mirrored ?? true, diagnostics: !!diagnostics, recognitionSettings,
    resetKey: `${state.mirrorId ?? 'default'}:${mode}:${welcome}:${paused}:${stopPending || localStopPending}:${needsRetry || serverError}:${gestureBlocked}:${gestureReset}`,
    onGesture: (gesture, metadata) => {
      const latest = currentRound.current;
      const ordered = enabledLooksForMode(latest.state);
      const index = ordered.findIndex(item => item.id === latest.state.selectedLookId);
      const next = ordered[(index + 1) % ordered.length];
      const input: ExhibitionCommand = { action: ['idle', 'select'].includes(latest.state.phase) ? 'select' : 'switch', lookId: next?.id };
      const context = diagnosticContext(latest.state);
      if (diagnostics && metadata) {
        if (metadata.raiseStartedAt !== undefined) diagnostics.record({ type: 'gesture_threshold', context, interactionId: metadata.eventId, actionId: `${metadata.eventId}-attempt-1`, at: metadata.raiseStartedAt });
        diagnostics.record({ type: 'gesture_confirmed', context, interactionId: metadata.eventId, actionId: `${metadata.eventId}-attempt-1`, at: metadata.detectedAt,
          metrics: { frameId: metadata.frameId, recognitionMs: metadata.detectedAt - metadata.sampledAt,
            ...(['wave', 'raise_hand', 'open_palm'].includes(gesture) ? { gesture: gesture as 'wave' | 'raise_hand' | 'open_palm' } : {}),
            ...(metadata.raiseStartedAt === undefined ? {} : { raiseLatencyMs: metadata.detectedAt - metadata.raiseStartedAt }) } });
      }
      if (!resolveExhibitionGestureSettings(latest.state.settings.gestureRecognition).gestures.includes(gesture as ExhibitionGestureKind) || !gesturesOn || !gestureAvailable || gestureBlocked
        || gesturePending.current || presenterTarget.current || gestures.operatorStatus !== 'locked'
        || gestures.status !== 'ready' || gestures.captureStatus !== 'active' || ordered.length < 2) {
        if (metadata) diagnostics?.record({ type: 'gesture_ignored', context, interactionId: metadata.eventId, actionId: `${metadata.eventId}-attempt-1`, reason: ordered.length < 2 ? 'insufficient_materials' : 'blocked' });
        return;
      }
      gesturePending.current = true;
      setGestureSelection({ lookId: next.id, revision: latest.state.revision });
      setGestureAcknowledgement(null);
      const acknowledgement: GestureAcknowledgement = {
        epoch: gestureFeedbackEpoch.current, mirrorId: latest.state.mirrorId ?? 'default', sessionNumber: latest.state.sessionNumber,
        mode: latest.state.experienceMode, revision: latest.state.revision, generationNumber: latest.state.generationNumber,
        previousLookId: latest.state.selectedLookId, lookId: next.id, action: input.action as 'select' | 'switch',
        label: input.action === 'select' ? '已选中' : mode === 'clothx' ? '换装已提交' : '素材切换已提交', showSuccess: true,
      };
      // Use the same selection path as the material drawer, including stop and lease guards.
      void command(input, metadata?.eventId)
        .then(accepted => {
          if (accepted === false) setGestureSelection(null);
          else if (accepted === true && acknowledgement.epoch === gestureFeedbackEpoch.current
            && matchesGestureTarget(acknowledgement, currentRound.current.state)) setGestureAcknowledgement(acknowledgement);
        })
        .catch(() => { setBeginError('素材切换未完成，请重试。'); setGestureSelection(null); })
        .finally(() => {
          gesturePending.current = false;
          setGestureSelection(target => target && (currentRound.current.state.selectedLookId === target.lookId
            || currentRound.current.state.revision > target.revision + 1) ? null : target);
        });
    },
  });
  const diagnosticSample = useRef({ state, gestures });
  diagnosticSample.current = { state, gestures };
  useEffect(() => {
    diagnostics?.observe(diagnosticContext(state), { active: realtime && !welcome && !paused && !needsRetry && !serverError
      && !locallyEnded && !stopPending && !localStopPending && !live?.updateError && !passive && !otherDevice });
  }, [diagnostics, state.mirrorId, state.sessionNumber, state.generationNumber, state.selectedLookId, realtime, welcome,
    paused, needsRetry, serverError, locallyEnded, stopPending, localStopPending, live?.updateError, passive, otherDevice]);
  useEffect(() => {
    if (!diagnostics) return;
    const sample = () => {
      const { state: current, gestures: value } = diagnosticSample.current;
      diagnostics.record({ type: 'sample', context: diagnosticContext(current), metrics: { operatorStatus: value.operatorStatus,
        captureStatus: value.captureStatus, width: value.inputWidth, height: value.inputHeight, fps: value.fps, inferenceMs: value.inferenceMs, recognitionMs: value.recognitionMs,
        armed: value.armed, handDetected: value.handDetected, handRaised: value.handRaised, needsRelease: value.needsRelease, controlSource: value.controlSource,
        confirmationState: value.confirmationState, palmHoldMs: value.palmHoldMs,
        palmConfirmMs: resolveExhibitionGestureSettings(current.settings.gestureRecognition).palmConfirmMs,
        rawHandCount: value.rawHandCount, matchedHandCount: value.matchedHandCount,
        ...(value.ambiguityReason ? { ambiguityReason: value.ambiguityReason } : {}) } });
    };
    sample();
    const timer = setInterval(sample, 1000);
    return () => clearInterval(timer);
  }, [diagnostics, gestures.confirmationState, gestures.palmHoldMs, gestures.rawHandCount, gestures.matchedHandCount, gestures.controlSource, gestures.captureStatus, recognitionSettings.palmConfirmMs]);
  const gestureCapturing = gestures.captureStatus === 'active';
  const gestureSeeingHand = gesturesOn && gestureAvailable && !gestureBlocked && gestureCapturing
    && gestures.operatorStatus === 'locked' && gestures.handDetected;
  const gestureAction = mode === 'clothx' ? '换装' : '换素材';
  const gestureInstruction = configuredGestures.length > 1 ? `挥手或展掌${gestureAction}` : configuredGestures[0] === 'wave' ? `挥手${gestureAction}` : `展掌${gestureAction}`;
  const currentAcknowledgement = !disabled && !needsRetry && !serverError && !stopPending && !localStopPending
    && gestureAcknowledgement?.epoch === gestureFeedbackEpoch.current
    && matchesGestureTarget(gestureAcknowledgement, state) ? gestureAcknowledgement : null;
  const gestureLabel = !configuredGestures.length ? '手势已关闭' : !gestureAvailable ? '等待摄像头' : !gesturesOn ? '手势已关闭'
    : gestures.status === 'error' ? '重试手势' : gestures.status === 'loading' ? '加载手势…'
      : gestures.captureStatus === 'stalled' ? '取景未更新'
        : ['disabled', 'muted', 'hidden'].includes(gestures.captureStatus) ? '取景已暂停'
          : currentAcknowledgement?.showSuccess && gestures.operatorStatus !== 'ambiguous' ? currentAcknowledgement.label
            : gestureProcessing ? '切换中'
            : gestureBlocked ? '手势已暂停'
              : !gestureCapturing ? '等待取景'
                : gestures.operatorStatus === 'ambiguous' ? gestures.ambiguityReason === 'hands' ? '请只露一只手' : '请单人体验'
                  : gestures.operatorStatus !== 'locked' ? '请露出手掌'
                    : gestures.confirmationState === 'raise_required' ? '可以再次抬手'
                      : gestures.confirmationState === 'lowering' || (configuredGestures.includes('open_palm')
                        && (gestures.needsRelease || gestures.confirmationState === 'already_triggered')) ? '请放下手'
                        : currentAcknowledgement && configuredGestures.includes('open_palm') && gestures.armed && !gestures.needsRelease ? '可以再次抬手'
                          : !gestures.handDetected ? '请露出手'
                            : gestures.needsRelease ? '收手或稍停' : gestures.armed ? gestureInstruction : '请露出手掌';
  if (!look || !visualLook || !enabled.length) return <section className="ex-kiosk ex-mirror-minimal ex-empty-mode" style={skinStyle} aria-label={passive ? '镜端状态预览' : presentation === 'terminal' ? '智能镜大屏' : kioskLabel} data-mode={EXHIBITION_MODE_LABELS[mode]} data-skin={skin}>
    <header className="ex-mirror-brand"><Brand /></header>
    <div className="ex-mirror-stage ex-mirror-empty"><Sparkles aria-hidden="true" /><span>暂无可用素材</span><div className="ex-mirror-stage-actions">{recoveryButton ?? stopButton ?? <button className="ex-kiosk-primary" disabled><Play fill="currentColor" />开始体验</button>}</div></div>
  </section>;
  const feedback = !locallyEnded && !passive && !otherDevice ? beginError || (realtime ? live?.error || live?.updateError || (serverError ? '换装连接状态未确认，请联系工作人员。' : '') : '') : '';
  return <section className={`ex-kiosk ex-mirror-minimal ex-phase-${state.phase}${welcome ? ' ex-welcome' : ''}${passive ? ' ex-passive' : ''}`} style={skinStyle} aria-label={kioskLabel} data-mode={EXHIBITION_MODE_LABELS[mode]} data-skin={skin}>
    <header className="ex-mirror-brand"><Brand /></header>
    <div className="ex-mirror-stage">
      {welcome ? (live?.cameraStream && !passive && !otherDevice && !mox ? <StreamVideo stream={live.cameraStream} mirrored={live?.mirrored} label="本地取景" /> : <img className="ex-mirror-poster" src={appUrl(visualLook.image)} alt={visualLook.name} />)
        : realtime && mox && !passive && !otherDevice && !needsRetry ? <MoXDragSurface interaction={live?.interaction ?? null} disabled={disabled || paused || !live?.interaction} imageUrl={!live?.outputStream || live?.presentation?.showInputImage ? live?.presentation?.inputImageUrl ?? appUrl(visualLook.image) : undefined}>
          {live?.outputStream && <StreamVideo stream={live.outputStream} mirrored={false} label={outputLabel} onFirstFrame={live.reportFirstFrame} />}
        </MoXDragSurface> : realtime ? (stream && !passive && (!needsRetry || cameraFallback) ? <StreamVideo key={!cameraFallback && live?.outputStream ? 'output' : 'camera'} stream={stream} mirrored={live?.mirrored} label={!cameraFallback && live?.outputStream ? outputLabel : '本地取景'} onFirstFrame={!cameraFallback && live?.outputStream ? live.reportFirstFrame : undefined} /> : <div className="ex-mirror-placeholder"><Sparkles aria-hidden="true" /><span>{livePlaceholder}</span>{passive ? <small>仅同步状态，未回传镜端视频</small> : otherDevice ? <small>当前页面未接收镜端视频</small> : needsRetry && !serverError && <button type="button" className="ex-kiosk-retry" disabled={disabled || live?.opening} onClick={() => void retryExperience()}><RotateCcw />重试</button>}</div>) : <img className="ex-mirror-poster" src={appUrl(visualLook.image)} alt={`${visualLook.name}素材预览`} />}
      {cameraFallback && <div className="ex-visual-status" role="status"><span>本地取景</span></div>}
      {localView && (visualSource || generationPending) && <div className="ex-visual-status" role="status" aria-live="polite">
        {visualSource && <span>{visualSource}</span>}
        {generationPending && <span className="ex-visual-generating"><Sparkles aria-hidden="true" />{preparationLabel}</span>}
      </div>}
      {!realtime && loading && <div className="ex-visual-status" role="status"><span>正在生成</span></div>}
      <MirrorMaterialDrawer key={mode} looks={enabled} selectedId={state.selectedLookId} disabled={!canChoose} passive={passive} columns={state.settings.materialDrawerColumns ?? 2}
        title={mode === 'clothx' ? '选择服装' : '选择素材'} onBusyChange={setCarouselBusy} onSelect={lookId => {
          const latest = currentRound.current;
          if (!latest.canChoose) return Promise.resolve(false);
          if (latest.state.phase === 'idle' || latest.state.phase === 'select') return command({ action: 'select', lookId });
          if (latest.state.phase === 'showcase' || latest.state.phase === 'generating') return command({ action: 'switch', lookId });
          return Promise.resolve(false);
        }} />
      {feedback && <div className="ex-mirror-feedback" role="alert"><span>{feedback}</span>{live?.updateError && !live.error && <button type="button" className="ex-kiosk-retry" disabled={disabled || stopPending || localStopPending} onClick={() => void live.retryUpdate()}><RotateCcw aria-hidden="true" />重试换装</button>}{welcome && realtime && !mox && live?.secure && live.error && !state.live && <><button type="button" className="ex-kiosk-retry" disabled={disabled || live.opening} onClick={() => { setBeginError(''); void live.startCamera(); }}><RotateCcw aria-hidden="true" />重试摄像头</button><a className="ex-kiosk-retry" href={appUrl(`/camera-check.html?mirror=${encodeURIComponent(state.mirrorId ?? 'default')}`)}>选择摄像头</a></>}</div>}
      {state.lifecycle?.idleEndsAt && !welcome && !passive && <div className="ex-mirror-feedback" role="status"><span>即将返回待机</span><button className="ex-kiosk-retry" disabled={disabled} onClick={() => void command({ action: 'keepalive' })}>继续体验</button></div>}
      {state.lifecycle?.connection === 'recovering' && !welcome && <div className="ex-mirror-feedback" role="status"><span>正在恢复连接</span></div>}
      {locallyEnded && !passive && <div className="ex-mirror-feedback" role="status"><span>本地体验已结束，云端凭证状态待确认。</span></div>}
      <div className="ex-mirror-stage-actions">
        {recoveryButton ?? stopButton ?? <button className="ex-kiosk-primary" disabled={disabled || passive || carouselBusy || beginPending || live?.opening || !!state.live} onClick={() => void command({ action: 'begin' })}><Play fill="currentColor" />{beginPending || live?.opening ? '等待摄像头…' : '开始体验'}</button>}
        {paused && !state.live && !stopPending && !localStopPending && <button className="ex-kiosk-continue" disabled={disabled || passive || live?.opening} onClick={() => { if (realtime && !remote) void retryExperience(); else void command({ action: 'resume' }); }}><Play fill="currentColor" />继续体验</button>}
      </div>
    </div>
    <footer className="ex-mirror-footer">
      {!welcome && <button type="button" className="ex-mirror-home" aria-label="返回首页" disabled={passive || !canControl || stopPending || localStopPending} onClick={() => void command({ action: 'idle' })}><ArrowLeft /></button>}
      {realtime && !mox && !remote && !passive && !otherDevice && canControl && <button type="button" className="ex-mirror-gesture" data-status={gestures.status}
        data-detection={gestureSeeingHand ? 'hand' : gestureBlocked ? 'paused' : 'waiting'} data-capture={gestures.captureStatus}
        data-hand-detected={!!gestures.handDetected} data-hand-raised={!!gestures.handRaised} data-inference-fps={gestures.fps}
        data-operator={gestures.operatorStatus} data-control-source={gestures.controlSource} data-armed={!!gestures.armed} data-processing={gestureProcessing}
        data-confirmation-state={gestures.confirmationState} data-enabled-gestures={configuredGestures.join(',')}
        data-capture-to-result-ms={gestures.recognitionMs} data-inference-ms={gestures.inferenceMs}
        disabled={!gestureAvailable || !configuredGestures.length} aria-pressed={gesturesOn && configuredGestures.length > 0} aria-busy={gestures.status === 'loading' || gestureProcessing}
        aria-label={!configuredGestures.length ? '手势识别已由后台关闭' : gestures.status === 'error' ? `重新开启手势${gestureAction}` : gesturesOn ? `关闭手势${gestureAction}` : `开启手势${gestureAction}`}
        title={gestures.error || gestureLabel} onClick={() => { if (!configuredGestures.length) return; if (gestures.status === 'error') gestures.retry(); else setGesturesOn(value => !value); }}>
        <Hand aria-hidden="true" /><span aria-live="polite">{gestureLabel}</span><i aria-hidden="true" />
      </button>}
    </footer>
  </section>;
}

type MirrorPreviewController = Pick<ExhibitionController, 'send' | 'stopExperience' | 'pending' | 'stopPending' | 'connected'> & { selectionPending?: boolean };

export function MirrorPreview({ state, controller }: { state: ExhibitionState; controller: MirrorPreviewController }) {
  return <section className="ex-monitor-preview ex-interactive-preview ex-preview-remote" aria-label="镜端预览">
    <div className="ex-subheading">镜端预览</div>
    <div className="ex-preview-connection" role="status"><i className={controller.connected ? 'is-online' : ''} />{controller.connected ? '状态已同步' : '连接已断开'}<span>{EXHIBITION_MODE_LABELS[state.experienceMode]}</span></div>
    <Kiosk state={state} send={controller.send} stopExperience={controller.stopExperience} stopPending={controller.stopPending}
      commandPending={controller.pending} selectionPending={controller.selectionPending}
      disabled={(controller.pending && !controller.selectionPending) || controller.stopPending || !controller.connected} presentation="remote" />
  </section>;
}

function MirrorPage({ mirror, registry, selectMirror, terminal }: { mirror: ExhibitionMirrorSummary; registry: MirrorRegistry; selectMirror: (id: string) => void; terminal?: TerminalBinding }) {
  const mirrorId = mirror.id;
  const controller = useExhibition(mirrorId);
  const { state, connected, pending, error, clearError, refresh } = controller;
  const path = window.location.pathname.replace(/\/$/, '');
  const screen = path.endsWith('/screen');
  const control = !screen;
  const [diagnostics, setDiagnostics] = useState<ExhibitionDiagnostics | null>(() => diagnosticsRequested(window.location.href) ? createExhibitionDiagnostics() : null);
  const onDiagnostic = useCallback((event: DiagnosticEventInput) => { diagnostics?.record(event); }, [diagnostics]);
  const closeDiagnostics = () => {
    diagnostics?.close(); setDiagnostics(null);
    const url = new URL(window.location.href); url.searchParams.delete('diagnostics'); window.history.replaceState(null, '', url);
  };
  const ownsMirror = !mirror.binding || (!!terminal?.connected && terminal.connection?.mirrorId === mirror.id && terminal.identity?.terminalId === mirror.binding.terminalId);
  const live = useExhibitionLive({ state, active: !control && ownsMirror, refresh, mirrorId, onDiagnostic: diagnostics ? onDiagnostic : undefined, selectionPending: controller.selectionPending, terminal: terminal?.connected && terminal.connection?.mirrorId === mirror.id ? terminal.identity ?? undefined : undefined });
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
    {screen ? <><Kiosk state={state} send={controller.send} stopExperience={controller.stopExperience} stopPending={controller.stopPending} commandPending={pending} selectionPending={controller.selectionPending} canControl={ownsMirror} disabled={(pending && !controller.selectionPending) || controller.stopPending || !connected || !ownsMirror} live={live} diagnostics={diagnostics} sendDiagnosed={controller.sendDiagnosed} />{diagnostics && <DiagnosticsPanel store={diagnostics} onClose={closeDiagnostics} />}{!terminal?.identity && <button className="ex-terminal-bind-trigger" onClick={terminal?.beginPairing}><Link2 size={14} />绑定设备</button>}{!ownsMirror && <span className="ex-terminal-preview-note">已绑定其他镜端 · 此页仅预览</span>}<button className="ex-fullscreen" aria-label="进入全屏" onClick={() => void fullScreen()}><Maximize2 size={16} /></button></> : <div className="ex-control-container"><MirrorConsole controller={controller} live={live} mirror={mirror} registry={registry} selectMirror={selectMirror} preview={<MirrorPreview key={mirror.id} state={state} controller={controller} />} /></div>}

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
