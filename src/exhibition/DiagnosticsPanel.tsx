import { useState, useSyncExternalStore } from 'react';
import { ChevronDown, ChevronUp, Download, Trash2, X } from 'lucide-react';
import type { DiagnosticEventType, DiagnosticMetrics, ExhibitionDiagnostics } from './diagnostics';
import { DEFAULT_EXHIBITION_GESTURE_SETTINGS } from '../../shared/exhibitionGestures';
import './diagnostics.css';

const stageLabels: Record<DiagnosticEventType, string> = {
  experience_started: '开始连接体验', credential_started: '申请临时凭证', credential_ready: '凭证就绪',
  rtc_started: '建立实时连接', rtc_ready: '实时连接就绪', reference_cache_hit: '复用已准备素材',
  gesture_threshold: '越过抬手阈值', gesture_confirmed: '动作确认', gesture_ignored: '动作未提交',
  command_sent: '命令提交', command_accepted: '命令接受', command_rejected: '命令失败', command_cancelled: '命令已取消',
  reference_started: '准备素材', reference_ready: '素材就绪', upload_started: '上传素材', upload_ready: '上传完成',
  bind_started: '关联素材', bind_ready: '关联完成', sdk_set_started: 'SDK set 开始', sdk_set_resolved: 'SDK set 返回',
  condition_committed: '更新已提交 · 待人工确认', session_first_frame: '会话首帧 · 待人工确认',
  failed: '生成失败', stopped: '已停止', manual_visible: '人工确认可见', sample: '识别采样',
};
const ms = (value: number | undefined) => value === undefined ? '—' : `${Math.round(value)} ms`;
const confirmationLabels: Record<NonNullable<DiagnosticMetrics['confirmationState']>, string> = {
  no_hand: '未检测到手', unmatched_hand: '手与操作者未匹配', settling: '正在锁定手掌', ambiguous: '手归属不明确',
  incomplete: '手掌未完整入镜', too_small: '手掌过小', fingers_folded: '掌形未确认', holding: '展掌确认中',
  already_triggered: '本次展掌已触发', release_required: '已触发 · 请放下手',
  lowering: '下放确认中', raise_required: '已复位 · 请抬手',
};

function confirmationLabel(sample: DiagnosticMetrics | undefined) {
  if (sample?.captureStatus !== 'active') return '暂停取景';
  if (sample.confirmationState) {
    if (sample.confirmationState === 'holding') {
      const targetMs = sample.palmConfirmMs ?? DEFAULT_EXHIBITION_GESTURE_SETTINGS.palmConfirmMs;
      return `展掌确认 ${sample.palmHoldMs === undefined ? '—' : Math.min(targetMs, Math.round(sample.palmHoldMs))} / ${targetMs} ms`;
    }
    return confirmationLabels[sample.confirmationState];
  }
  return sample.operatorStatus !== 'locked' ? '未锁定' : !sample.handDetected ? '手未入镜'
    : sample.needsRelease ? '收手或稍停' : sample.armed ? '可挥手 / 展掌' : '张开手掌';
}

export function DiagnosticsPanel({ store, onClose }: { store: ExhibitionDiagnostics; onClose: () => void }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [collapsed, setCollapsed] = useState(false);
  const sample = [...snapshot.events].reverse().find(event => event.type === 'sample')?.metrics;
  const stages = snapshot.events.filter(event => event.type !== 'sample');
  const gestures = stages.filter(event => event.type === 'gesture_confirmed');
  const waveCount = gestures.filter(event => event.metrics?.gesture === 'wave').length;
  const palmCount = gestures.filter(event => event.metrics?.gesture === 'open_palm').length;
  const latencies = stages.filter(event => event.type === 'gesture_confirmed' && event.metrics?.raiseLatencyMs !== undefined)
    .map(event => event.metrics!.raiseLatencyMs!).sort((a, b) => a - b);
  const p95 = latencies.length ? latencies[Math.ceil(latencies.length * .95) - 1] : undefined;
  const manual = [...stages].reverse().find(event => event.type === 'manual_visible');
  const submitted = manual && [...stages].reverse().find(event => event.type === 'sdk_set_started' && event.operationId === manual.operationId);
  const requested = manual && [...stages].reverse().find(event => event.type === 'command_sent' && event.actionId === manual.actionId);
  const exportJSON = () => {
    const url = URL.createObjectURL(new Blob([store.exportJSON()], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `mirror-diagnostics-${Date.now()}.json`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <aside className="ex-diagnostics" aria-label="智能镜诊断">
    <header><strong>联调诊断</strong><span>{snapshot.events.length.toLocaleString()} / 10,000</span>
      <button type="button" aria-label={collapsed ? '展开诊断' : '收起诊断'} aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? <ChevronDown /> : <ChevronUp />}</button>
      <button type="button" aria-label="关闭诊断" onClick={onClose}><X /></button>
    </header>
    {!collapsed && <div className="ex-diagnostics-body">
      <dl className="ex-diagnostics-metrics">
        <div><dt>操作者</dt><dd>{sample?.operatorStatus === 'locked' ? sample.controlSource === 'hand' ? '单手锁定' : '人体锁定' : sample?.operatorStatus === 'ambiguous' ? sample.ambiguityReason === 'hands' ? '多手入镜' : '多人入区' : '寻找中'}</dd></div>
        <div><dt>手势{sample?.rawHandCount !== undefined ? ` · 检出 ${sample.rawHandCount} / 匹配 ${sample.matchedHandCount ?? '—'}` : ''}</dt><dd>{confirmationLabel(sample)}</dd></div>
        <div><dt>识别帧率{sample?.width ? ` · ${sample.width} × ${sample.height}` : ''}</dt><dd>{sample?.fps?.toFixed(1) ?? '—'} FPS</dd></div>
        <div><dt>推理 / 取帧至结果</dt><dd>{ms(sample?.inferenceMs)} / {ms(sample?.recognitionMs)}</dd></div>
        {latencies.length > 0 && <div><dt>抬手确认 P95 · {latencies.length} 次</dt><dd>{ms(p95)}</dd></div>}
        <div><dt>手势确认{snapshot.droppedCount > 0 ? ' · 最近记录' : ''}</dt><dd>{gestures.length} 次 · 挥手 {waveCount} / 展掌 {palmCount}</dd></div>
        <div><dt>会话 / 生成轮次</dt><dd>{snapshot.current?.sessionNumber ?? '—'} / {snapshot.current?.generationNumber ?? '—'}</dd></div>
      </dl>
      <p className="ex-diagnostics-stage" role="status">{snapshot.latestStage ? stageLabels[snapshot.latestStage] : '等待记录'}</p>
      <div className="ex-diagnostics-counts"><span>人工确认 <b>{snapshot.stats.confirmed}</b></span><span>未确认 <b>{snapshot.stats.unconfirmed}</b></span><span>失败 <b>{snapshot.stats.failed}</b></span></div>
      <button type="button" className="ex-diagnostics-confirm" disabled={!snapshot.canMarkVisible} onClick={() => store.markVisible(snapshot.current ?? undefined)}>已看到新衣服</button>
      <p className="ex-diagnostics-note">人工观察值；SDK 返回与会话首帧不代表本套服装已出现。</p>
      {manual && <p className="ex-diagnostics-note">上次人工观察：提交后 {ms(requested ? manual.at - requested.at : undefined)} · SDK 开始后 {ms(submitted ? manual.at - submitted.at : undefined)}</p>}
      <ol className="ex-diagnostics-timeline" aria-label="最近诊断事件">{stages.slice(-16).reverse().map((event, index) => <li key={`${snapshot.version}-${index}`}>
        <time>{(event.at / 1000).toFixed(2)} s</time><span>{stageLabels[event.type]}</span>
        <small>轮次 {event.context.generationNumber}{event.metrics?.durationMs !== undefined ? ` · ${ms(event.metrics.durationMs)}` : ''}</small>
      </li>)}</ol>
      <footer><button type="button" onClick={exportJSON}><Download />导出 JSON</button><button type="button" onClick={() => store.clear()}><Trash2 />清空记录</button></footer>
      {snapshot.droppedCount > 0 && <p className="ex-diagnostics-note">已滚动移除 {snapshot.droppedCount.toLocaleString()} 条早期记录</p>}
    </div>}
  </aside>;
}
