import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check, Upload } from 'lucide-react';
import { EXHIBITION_UI_SKIN_PRESETS, type ExhibitionUiSkinPreset } from '../../shared/exhibition';
import { appUrl } from '../versionScope';
import type { ExhibitionController } from './useExhibition';
import { mirrorSkin, MIRROR_SKIN_LABELS, MirrorSkinThumbnail } from './uiSkins';

const MAX_BYTES = 8 * 1024 * 1024;
function validateFile(file: File) {
  if (!/\.(jpe?g|png|webp)$/i.test(file.name)) return '请选择 PNG、JPG 或 WebP 图片。';
  if (!file.size) return '图片为空，请重新选择。';
  if (file.size > MAX_BYTES) return '皮肤图片不能超过 8 MB。';
  return '';
}
function readSize(url: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new globalThis.Image();
    const timer = setTimeout(() => reject(new Error('图片读取超时，请重新选择。')), 15000);
    image.onload = () => { clearTimeout(timer); resolve({ width: image.naturalWidth, height: image.naturalHeight }); };
    image.onerror = () => { clearTimeout(timer); reject(new Error('无法读取这张图片，请重新选择。')); };
    image.src = url;
  });
}
function readBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const timer = setTimeout(() => { reject(new Error('文件读取超时，请重试。')); reader.abort(); }, 15000);
    reader.onload = () => { clearTimeout(timer); resolve(String(reader.result)); };
    reader.onerror = () => { clearTimeout(timer); reject(new Error('文件读取失败，请重试。')); };
    reader.onabort = () => { clearTimeout(timer); reject(new Error('文件读取已取消，请重试。')); };
    reader.readAsDataURL(file);
  });
}

export function MirrorUiSkinSettings({ controller }: { controller: ExhibitionController }) {
  const { state, pending, connected } = controller;
  const noteId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [baseline, setBaseline] = useState<number>();
  const [preview, setPreview] = useState('');
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    setSize(null); setError(''); setPreview('');
    if (!file) { setReading(false); return; }
    const invalid = validateFile(file);
    if (invalid) { setError(invalid); setReading(false); return; }
    let cancelled = false;
    const url = URL.createObjectURL(file);
    setPreview(url); setReading(true);
    void readSize(url).then(dimensions => {
      if (cancelled) return;
      const ratio = dimensions.width / dimensions.height;
      if (!Number.isFinite(ratio) || ratio < 0.45 || ratio > 0.75) setError('请使用 9:16 附近的竖图，宽高比需在 0.45–0.75 之间。');
      else setSize(dimensions);
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : '图片读取失败。'); })
      .finally(() => { if (!cancelled) setReading(false); });
    return () => { cancelled = true; URL.revokeObjectURL(url); };
  }, [file]);
  if (!state) return null;
  const skin = state.settings.uiSkin;
  const activeSkin = mirrorSkin(state);
  const configurable = ['idle', 'select'].includes(state.phase) && !state.live;
  const disabled = pending || controller.stopPending || saving || !connected || !configurable;
  function resetFile() { setFile(null); setBaseline(undefined); if (input.current) input.current.value = ''; }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (disabled || reading || !file || !size || error || inFlight.current) return;
    inFlight.current = true; setSaving(true); setError('');
    try {
      const imageBase64 = await readBase64(file);
      if (!alive.current) return;
      if (await controller.uploadUiSkin({ imageBase64, expectedRevision: baseline }) && alive.current) resetFile();
      else if (alive.current) setError('皮肤未保存，请重新选择图片后重试。');
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '皮肤保存失败，请重试。'); }
    finally { inFlight.current = false; if (alive.current) setSaving(false); }
  }
  async function restore() {
    if (disabled || !skin || inFlight.current) return;
    inFlight.current = true; setSaving(true); setError('');
    try {
      if (await controller.removeUiSkin({ expectedRevision: state!.revision }) && alive.current) resetFile();
      else if (alive.current) setError('恢复未完成，请核对最新状态后重试。');
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '恢复失败，请重试。'); }
    finally { inFlight.current = false; if (alive.current) setSaving(false); }
  }
  async function selectPreset(preset: ExhibitionUiSkinPreset) {
    if (disabled || inFlight.current || (activeSkin === preset && !file)) return;
    if (activeSkin === preset) { resetFile(); setError(''); controller.clearError(); return; }
    inFlight.current = true; setSaving(true); setError(''); controller.clearError();
    try {
      if (await controller.send({ action: 'configure', uiSkinPreset: preset, expectedRevision: state!.revision }) && alive.current) {
        resetFile();
      } else if (alive.current) setError('皮肤未切换，请重试。');
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '皮肤切换失败，请重试。'); }
    finally { inFlight.current = false; if (alive.current) setSaving(false); }
  }
  return <form className="ex-ui-skin-settings" aria-label="镜端皮肤设置" onSubmit={event => void save(event)}>
    <div className="ex-ui-skin-controls"><div className="ex-ui-skin-heading"><strong>镜端皮肤</strong><span>{file ? '待保存' : activeSkin === 'custom' ? '自定义皮肤' : MIRROR_SKIN_LABELS[activeSkin]}</span></div>
      <div className="ex-ui-skin-presets" role="group" aria-label="默认皮肤">
        {EXHIBITION_UI_SKIN_PRESETS.map(preset => <button key={preset} type="button" className="ex-ui-skin-preset" aria-label={MIRROR_SKIN_LABELS[preset]} aria-pressed={activeSkin === preset} disabled={disabled} onClick={() => void selectPreset(preset)}>
          <MirrorSkinThumbnail preset={preset} />
          <span>{MIRROR_SKIN_LABELS[preset]}{activeSkin === preset && <Check size={12} aria-hidden="true" />}</span>
        </button>)}
      </div>
      <div className="ex-ui-skin-custom">
      {(preview || skin) && <div className="ex-ui-skin-preview"><img src={preview || appUrl(skin!.image)} alt={preview ? '待保存的镜端皮肤' : '当前镜端皮肤'} /></div>}
      <div className="ex-ui-skin-upload-controls">
      <div className="ex-ui-skin-actions"><label className={`ex-ui-skin-picker${disabled ? ' is-disabled' : ''}`}><Upload size={13} aria-hidden="true" />{file ? '重新选择' : '上传自定义皮肤'}<input ref={input} type="file" aria-label="镜端皮肤图片" aria-describedby={noteId} accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" disabled={disabled} onChange={event => { if (disabled || inFlight.current) return; setFile(event.target.files?.[0] ?? null); setBaseline(state.revision); setError(''); controller.clearError(); }} /></label>
        {file && <button className="ex-button" disabled={disabled || reading || !size || !!error}>{saving ? '保存中…' : '保存皮肤'}</button>}
        {skin && <button type="button" className="ex-button ex-ui-skin-restore" disabled={disabled} onClick={() => void restore()}>恢复默认</button>}
        {file && <button type="button" className="ex-reset-setting" disabled={saving || pending} onClick={() => { resetFile(); setError(''); controller.clearError(); }}>取消选择</button>}
      </div>
      <p id={noteId}>9:16 竖图 · PNG / JPG / WebP · 最大 8 MB</p>
      </div></div>
      {reading && <p className="ex-ui-skin-feedback" role="status">正在检查图片…</p>}
      {!configurable && <p className="ex-ui-skin-feedback" role="status">结束体验并等待实时会话停止后可修改。</p>}
      {!connected && <p className="ex-ui-skin-feedback" role="status">状态同步断开，恢复连接后可修改。</p>}
      {error && <p className="ex-field-error" role="alert">{controller.error || error}</p>}
    </div>
  </form>;
}
