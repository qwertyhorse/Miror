import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, GripVertical, ImagePlus, Plus, Search, Trash2, Upload, X } from 'lucide-react';
import { EXHIBITION_FREE_PROMPT_MAX_LENGTH, exhibitionReferenceImage, type ExhibitionExperienceMode, type ExhibitionLook, type ExhibitionUploadLimits } from '../../shared/exhibition';
import { appUrl } from '../versionScope';
import { looksFor } from './catalog';
import type { ExhibitionController } from './useExhibition';
import type { MirrorRegistry } from './useMirrors';
import { CopyDialog } from './CopyDialog';
import { ExperienceModeChips, experienceModeLabel } from './ExperienceModeChips';
import { enableLookInOrder, useMaterialOrder } from './useMaterialOrder';
import { MaterialActionsMenu } from './MaterialActionsMenu';
import { ReferencePreparationBadge } from './ReferencePreparationBadge';
import { useReferencePreparation } from './useReferencePreparation';
import './wardrobe.css';
import { MaterialPublication } from './MaterialPublication';
import { MaterialBatchImport } from './MaterialBatchImport';

function validateFile(file: File, limits: ExhibitionUploadLimits) {
  if (!/\.(jpe?g|png|webp)$/i.test(file.name)) return '请选择 JPG、PNG 或 WebP 图片。';
  if (file.size > limits.maxFileSizeMB * 1024 * 1024) return `图片不能超过 ${limits.maxFileSizeMB} MB，当前为 ${(file.size / 1024 / 1024).toFixed(2)} MB。`;
  if (!file.size) return '图片为空，请重新选择。';
  return '';
}
function imageSize(url: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => reject(new Error('图片读取超时，请重新选择。')), 15000);
    image.onload = () => { clearTimeout(timer); resolve({ width: image.naturalWidth, height: image.naturalHeight }); };
    image.onerror = () => { clearTimeout(timer); reject(new Error('无法读取这张图片，请检查文件是否完整。')); };
    image.src = url;
  });
}
function toBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('文件读取失败，请重试。'));
    reader.readAsDataURL(file);
  });
}

function materialName(file: File): string {
  return file.name.replace(/\.(jpe?g|png|webp)$/i, '').normalize('NFC').replace(/\p{Cc}/gu, '').trim()
    .slice(0, 40).replace(/[\uD800-\uDBFF]$/u, '').trim() || '未命名素材';
}

function useMaterialImage(limits: ExhibitionUploadLimits) {
  const [file, setFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<{ file: File | null; preview: string; size: { width: number; height: number } | null; error: string; reading: boolean }>({ file: null, preview: '', size: null, error: '', reading: false });
  const limitsKey = JSON.stringify(limits);
  useEffect(() => {
    const empty = { file, preview: '', size: null, error: '', reading: false };
    if (!file) { setInspection(empty); return; }
    const rule = JSON.parse(limitsKey) as ExhibitionUploadLimits;
    const validation = validateFile(file, rule);
    if (validation) { setInspection({ ...empty, error: validation }); return; }
    const url = URL.createObjectURL(file); let stopped = false;
    setInspection({ ...empty, preview: url, reading: true });
    void imageSize(url).then(size => {
      if (stopped) return;
      const error = size.width < rule.minWidth || size.width > rule.maxWidth || size.height < rule.minHeight || size.height > rule.maxHeight
        ? `当前 ${size.width} × ${size.height} px。宽度需为 ${rule.minWidth}–${rule.maxWidth} px，高度需为 ${rule.minHeight}–${rule.maxHeight} px。`
        : size.width * size.height > 32000000 ? '图片总像素不能超过 3200 万。' : '';
      setInspection({ file, preview: url, size: error ? null : size, error, reading: false });
    }).catch(cause => {
      if (!stopped) setInspection({ ...empty, preview: url, error: cause instanceof Error ? cause.message : '图片读取失败。' });
    });
    return () => { stopped = true; URL.revokeObjectURL(url); };
  }, [file, limitsKey]);
  // A newly chosen file must never inherit the preceding file's validation.
  const current = inspection.file === file ? inspection : { preview: '', size: null, error: '', reading: !!file };
  return { ...current, file, setFile, valid: !!file && !!current.size && !current.error && !current.reading };
}

function MaterialImageField({ label, image, existing, disabled, required, promptOnly = false, onChange }: {
  label: string; image: ReturnType<typeof useMaterialImage>; existing?: string | null;
  disabled: boolean; required: boolean; promptOnly?: boolean; onChange: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const source = image.file ? image.preview : existing ? appUrl(existing) : '';
  function choose(file: File | null) {
    if (disabled) return;
    image.setFile(file); onChange();
  }
  return <div className="ex-image-field">
    <div className="ex-image-label"><span>{label}</span>{required && !existing ? <small>必填</small> : promptOnly ? <small>可选</small> : null}</div>
    <div className="ex-upload-preview">{source ? <img src={source} alt={label} /> : <><ImagePlus size={32} /><span>{promptOnly ? '仅提示词' : label}</span></>}</div>
    <label className="ex-file-picker"><Upload size={16} />{source || image.file ? '更换图片' : '选择图片'}<input ref={input} aria-label={`${label}文件`} aria-describedby={image.error ? errorId : undefined} aria-invalid={!!image.error} required={required && !existing} type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" disabled={disabled} onChange={event => {
      const selected = event.target.files?.[0];
      if (selected) choose(selected);
    }} /></label>
    {image.reading && <p className="ex-form-note" role="status">正在检查图片…</p>}
    {image.file && image.size && <p className="ex-file-accepted"><Check size={14} />{image.size.width} × {image.size.height} px · {(image.file.size / 1024 / 1024).toFixed(2)} MB</p>}
    {image.error && <p id={errorId} className="ex-field-error" role="alert">{image.error}</p>}
    {image.file && <button type="button" className="ex-image-reset" disabled={disabled} aria-label={`${existing ? '撤销更换' : '移除'}${label}`} onClick={() => { if (disabled) return; if (input.current) input.current.value = ''; choose(null); }}>{existing ? '撤销更换' : '移除图片'}</button>}
  </div>;
}

function useEditorDialog() {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    element?.showModal();
    const firstControl = element?.querySelector<HTMLInputElement>('input[type="file"]:not(:disabled)')
      ?? element?.querySelector<HTMLElement>('[autofocus]:not(:disabled)')
      ?? element?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    firstControl?.focus({ preventScroll: true });
    return () => { element?.close(); if (previousFocus?.isConnected && !previousFocus.matches(':disabled')) previousFocus.focus({ preventScroll: true });
      else document.querySelector<HTMLInputElement>('.ex-library-search input')?.focus({ preventScroll: true }); };
  }, []);
  return dialog;
}

export function LookEditor({ controller, look, initialMode, close, saved, deleted, initialDelete = false }: {
  controller: ExhibitionController; look?: ExhibitionLook; initialMode: ExhibitionExperienceMode;
  close: () => void; saved: (mode: ExhibitionExperienceMode) => void; deleted: () => void; initialDelete?: boolean;
}) {
  const { state, pending, connected, upload, updateLook, deleteLook } = controller;
  const [baseline] = useState(state!.revision);
  const [mode, setMode] = useState(look?.mode ?? initialMode);
  const [prompt, setPrompt] = useState(look?.prompt ?? '');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const saving = useRef(false);
  const [deleteConfirm, setDeleteConfirm] = useState(initialDelete);
  const alive = useRef(true);
  const dialog = useEditorDialog();
  const limits = state!.settings.uploadLimits;
  const displayImage = useMaterialImage(limits);
  const referenceImage = useMaterialImage(limits);
  const existingReference = look ? exhibitionReferenceImage(look) : null;
  const promptOnly = look?.referenceKind === 'none' && mode === 'free' && !referenceImage.file;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const configurable = ['idle', 'select'].includes(state!.phase) && !state!.live;
  const unavailable = pending || submitting || !connected;
  const valid = mode !== 'free' || !!prompt.trim();
  const displayValid = displayImage.file ? displayImage.valid : !!look?.image;
  const referenceValid = referenceImage.file ? referenceImage.valid : !!existingReference || promptOnly;
  async function remove() {
    if (!look || unavailable || !configurable || saving.current) return;
    saving.current = true;
    setSubmitting(true); setError('');
    try { if (await deleteLook(look.id, { expectedRevision: baseline }) && alive.current) deleted(); }
    finally { saving.current = false; if (alive.current) setSubmitting(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (unavailable || saving.current || deleteConfirm || !valid) return;
    if (!displayValid || !referenceValid) { setError(`请选择符合限制的${!displayValid ? '展示图' : ' 模型参考图'}。`); return; }
    saving.current = true;
    setSubmitting(true);
    try {
      const [imageBase64, referenceImageBase64] = await Promise.all([
        displayImage.file ? toBase64(displayImage.file) : undefined,
        referenceImage.file ? toBase64(referenceImage.file) : undefined,
      ]);
      if (!alive.current) return;
      const input = { name: look?.name ?? materialName(displayImage.file!), description: look?.description ?? '', mode, prompt: mode === 'free' ? prompt.trim() : '',
        ...(look?.referenceKind === 'none' ? { referenceKind: promptOnly ? 'none' as const : 'image' as const } : {}) };
      if (look) {
        if (await updateLook(look.id, { ...input, ...(imageBase64 ? { imageBase64 } : {}), ...(referenceImageBase64 ? { referenceImageBase64 } : {}), expectedRevision: baseline }) && alive.current) saved(mode);
      } else {
        if (await upload({ ...input, imageBase64: imageBase64!, referenceImageBase64: referenceImageBase64! }) && alive.current) saved(mode);
      }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '保存失败，请重试。'); }
    finally { saving.current = false; if (alive.current) setSubmitting(false); }
  }
  return <dialog ref={dialog} className={`ex-editor-dialog${deleteConfirm ? ' ex-delete-dialog' : ''}`} aria-label={deleteConfirm ? '删除素材' : look ? '编辑素材' : '上传素材'} onCancel={event => { event.preventDefault(); if (!submitting && !pending) close(); }}><form className="ex-look-editor" onSubmit={event => void submit(event)} aria-label={deleteConfirm ? '删除素材' : look ? '编辑素材' : '上传素材'}>
    <div className="ex-editor-heading"><h3>{deleteConfirm ? '删除素材' : look ? '编辑素材' : '上传新素材'}</h3><button type="button" className="ex-icon-button" onClick={close} disabled={submitting || pending} aria-label={deleteConfirm ? '关闭删除确认' : '关闭素材编辑'}><X size={18} /></button></div>
    {deleteConfirm && look ? <div className="ex-delete-preview"><img src={appUrl(look.image)} alt={`${look.name}素材`} /><div><strong>{look.name}</strong><p>{experienceModeLabel(look.mode)} · {look.source === 'upload' ? '上传素材' : '示例素材'}</p></div></div> : <div className="ex-editor-grid">
      <div className="ex-editor-images">
        <div className="ex-image-pair">
          <MaterialImageField label="展示图" image={displayImage} existing={look?.image} disabled={unavailable} required={!look} onChange={() => setError('')} />
          <MaterialImageField label="模型参考图" image={referenceImage} existing={existingReference} disabled={unavailable} required={!promptOnly} promptOnly={promptOnly} onChange={() => setError('')} />
        </div>
        <p className="ex-form-note">JPG / PNG / WebP · 每张 ≤ {limits.maxFileSizeMB} MB<br />宽 {limits.minWidth}–{limits.maxWidth} px · 高 {limits.minHeight}–{limits.maxHeight} px</p>
      </div>
      <fieldset disabled={unavailable} className="ex-editor-fields">
        <ExperienceModeChips label="所属模式" value={mode} onChange={setMode} disabled={unavailable} />
        {mode === 'free' && <label>Free 提示词 <small>必填</small><textarea required maxLength={EXHIBITION_FREE_PROMPT_MAX_LENGTH} rows={4} value={prompt} placeholder="描述希望生成的画面和素材使用方式" onChange={event => setPrompt(event.target.value)} /></label>}
      </fieldset>
    </div>}
    {(error || controller.error) && <p className="ex-field-error" role="alert">{error || controller.error}</p>}
    {deleteConfirm && look ? <div className="ex-delete-confirm" role="group" aria-label="删除素材确认"><strong>确认删除「{look.name}」？</strong><p>删除后将从本设备素材库移除，无法撤销。{state!.enabledLookIds.includes(look.id) && '大屏将同步停止提供这份素材。'}</p>{!configurable && <p role="status">体验进行中，请结束体验并等待实时会话停止后再删除。</p>}<div><button type="button" className="ex-button" autoFocus disabled={submitting || pending} onClick={() => initialDelete ? close() : setDeleteConfirm(false)}>保留素材</button><button type="button" className="ex-button ex-delete-button" disabled={unavailable || !configurable} onClick={() => void remove()}>{submitting || pending ? '正在删除…' : '确认删除'}</button></div></div>
      : <div className="ex-editor-footer">{look && <button type="button" className="ex-button ex-delete-button" disabled={unavailable || !configurable} onClick={() => setDeleteConfirm(true)}><Trash2 size={15} />删除素材</button>}<button type="button" className="ex-button" disabled={submitting || pending} onClick={close}>取消</button><button className="ex-button ex-primary" disabled={unavailable || !valid || !displayValid || !referenceValid}>{submitting || pending ? '正在保存…' : look ? '保存素材' : '上传并保存'}</button></div>}
  </form></dialog>;
}

interface WardrobePanelProps { controller: ExhibitionController; registry?: MirrorRegistry; onSummaryChange?: (summary: string | null) => void; }

export function WardrobePanel({ controller, registry, onSummaryChange }: WardrobePanelProps) {
  return <WardrobeContent key={controller.mirrorId} controller={controller} registry={registry} onSummaryChange={onSummaryChange} />;
}

function WardrobeContent({ controller, registry, onSummaryChange }: WardrobePanelProps) {
  const { state, send, pending, connected } = controller;
  const [mode, setMode] = useState<ExhibitionExperienceMode>(state?.experienceMode ?? 'clothx');
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<string | null>(null);
  const [copyLook, setCopyLook] = useState<ExhibitionLook | null>(null);
  // Polling must not change the target or revision of an open edit/delete dialog.
  const [editorLook, setEditorLook] = useState<ExhibitionLook | undefined>();
  const [initialDelete, setInitialDelete] = useState(false);
  const [notice, setNotice] = useState('');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const results = useRef<HTMLDivElement>(null);
  const orderHintId = useId();
  useEffect(() => { if (results.current) results.current.scrollTop = 0; }, [mode, query]);
  const looks = state ? looksFor(state) : [];
  const referenceCatalogKey = JSON.stringify(looks.map(look => [look.id, exhibitionReferenceImage(look), look.referenceKind]));
  const preparation = useReferencePreparation(controller.mirrorId, referenceCatalogKey, !!state?.looks);
  const modeLooks = looks.filter(look => look.mode === mode);
  const configurable = !!state && ['idle', 'select'].includes(state.phase) && !state.live;
  const disabled = pending || !connected || !configurable;
  const orderDisabled = disabled || !!query.trim() || !!editor || !!copyLook;
  const order = useMaterialOrder({ mirrorId: controller.mirrorId, revision: state?.revision ?? 0, mode, lookIds: modeLooks.map(look => look.id),
    disabled: orderDisabled, region: results, send });
  useEffect(() => { setOpenMenuId(null); }, [mode, query, editor, copyLook, disabled, order.saving, order.draggedId]);
  const byId = new Map(modeLooks.map(look => [look.id, look]));
  const filtered = order.ids.flatMap(id => { const look = byId.get(id); return look && `${look.name} ${look.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) ? [look] : []; });
  const enabledCount = modeLooks.filter(look => state?.enabledLookIds.includes(look.id)).length;
  const summary = state?.looks && state.settings.uploadLimits ? `${experienceModeLabel(mode)} · ${modeLooks.length} 份素材 · ${enabledCount} 份已启用${query.trim() ? ` · 搜索到 ${filtered.length} 份` : ''}` : null;
  useEffect(() => { onSummaryChange?.(summary); }, [onSummaryChange, summary]);
  useEffect(() => () => { onSummaryChange?.(null); }, [onSummaryChange]);
  if (!state?.looks || !state.settings.uploadLimits) return <p>正在更新素材库服务，请稍后刷新。</p>;
  function openEditor(next: string, deleting = false) { setOpenMenuId(null); controller.clearError(); setEditorLook(looks.find(item => item.id === next)); setEditor(next); setInitialDelete(deleting); setNotice(''); }
  function savedEditor(savedMode: ExhibitionExperienceMode) {
    setNotice(editor === 'upload' ? '素材已保存。' : '素材信息已保存。');
    setMode(savedMode); setQuery(''); setEditor(null);
  }
  return <div className="ex-library">
    {notice && <p role="status" className="ex-library-notice"><Check size={16} />{notice}</p>}
    {preparation.error && <div className="ex-reference-fetch-error" role="alert"><span>{preparation.error}</span><button type="button" onClick={preparation.refresh}>刷新状态</button></div>}
    {editor && <LookEditor key={editor} controller={controller} look={editorLook} initialMode={mode} initialDelete={initialDelete} close={() => setEditor(null)} saved={savedEditor} deleted={() => { setNotice('素材已删除。'); setEditor(null); }} />}
    {copyLook && registry && <CopyDialog source={{ id: controller.mirrorId, name: registry.data?.mirrors.find(item => item.id === controller.mirrorId)?.name ?? '当前智能镜' }} registry={registry} look={copyLook} close={() => setCopyLook(null)} copied={(id, message) => { setNotice(message); if (id === controller.mirrorId) void controller.refresh(); }} />}
    <MaterialPublication controller={controller} /><MaterialBatchImport controller={controller} />
    <div className="ex-library-filters"><ExperienceModeChips label="按模式筛选素材" value={mode} onChange={setMode} /><label className="ex-library-search"><Search size={16} /><input aria-label="搜索素材" placeholder="搜索素材名称、说明" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="ex-library-actions"><button className="ex-button ex-primary" disabled={pending || !connected} onClick={() => openEditor('upload')}><Plus size={17} />上传素材</button></div></div>
    <span id={orderHintId} className="ex-sr-only">{query.trim() ? '清空搜索后可拖动排序。' : '拖动图片或手柄排序；手柄支持方向键、Home 和 End。'}</span><span className="ex-sr-only" role="status" aria-live="polite">{order.message}</span>
    <div ref={results} className="ex-library-results" role="region" aria-label={`${experienceModeLabel(mode)} 素材列表，可纵向滚动`} tabIndex={0} {...order.regionProps}>
      {filtered.length > 0 ? <div className="ex-library-grid">{filtered.map(item => <article className={`ex-library-card${order.draggedId === item.id ? ' ex-library-card-dragging' : ''}`} key={item.id} data-material-id={item.id}>
        <div className="ex-library-image" data-material-drag-image data-draggable={!orderDisabled && !order.saving && modeLooks.length > 1} {...order.imageProps(item.id)}><img src={appUrl(item.image)} alt={`${item.name}素材`} loading="lazy" draggable={false} /><button type="button" className="ex-material-drag-handle" data-material-order-id={item.id} aria-label={`调整${item.name}顺序`} aria-describedby={orderHintId} title="调整顺序" disabled={orderDisabled || order.saving || modeLooks.length < 2} {...order.handleProps(item.id)}><GripVertical size={17} aria-hidden="true" /></button></div>
        <div className="ex-library-card-body">
          <div className="ex-library-card-title"><h3>{item.name}</h3><div className="ex-library-card-tools"><MaterialActionsMenu name={item.name} open={openMenuId === item.id} onOpenChange={open => setOpenMenuId(open ? item.id : null)} onEdit={() => openEditor(item.id)} onCopy={() => { setCopyLook({ ...item }); setNotice(''); }} onDelete={() => openEditor(item.id, true)} editDisabled={pending || !connected} copyDisabled={!registry?.data} deleteDisabled={disabled} disabled={!connected || order.saving || !!order.draggedId} /></div></div>
          <span className="ex-material-mode">{experienceModeLabel(item.mode)}{item.referenceKind === 'none' && ' · 仅提示词'} · {state.publication?.looks.some(published => published.id === item.id) ? JSON.stringify(state.publication.looks.find(published => published.id === item.id)) === JSON.stringify(item) ? '已发布' : '草稿已修改' : '草稿'}</span>
          <ReferencePreparationBadge name={item.name} status={preparation.references[item.id]} unavailable={!!preparation.error} retrying={preparation.retrying.has(item.id)} retryError={preparation.retryErrors[item.id]} now={preparation.now} onRetry={() => { void preparation.retry(item.id); }} />
          <div className="ex-library-file-row"><p className="ex-library-file-info">{item.width ? `${item.width} × ${item.height} px · ${((item.bytes ?? 0) / 1024 / 1024).toFixed(2)} MB` : '预设示例素材'}</p><label className="ex-material-enabled-control" title={state.enabledLookIds.includes(item.id) ? '已启用' : '未启用'}><input aria-label={`启用${item.name}`} role="switch" type="checkbox" checked={state.enabledLookIds.includes(item.id)} disabled={disabled || order.saving || !!order.draggedId} onChange={event => { void send({ action: 'configure', enabledLookIds: event.target.checked ? enableLookInOrder(looks, state.enabledLookIds, item) : state.enabledLookIds.filter(id => id !== item.id) }); }} /><span aria-hidden="true" /></label></div>
        </div>
      </article>)}</div> : <div className="ex-library-empty"><ImagePlus size={28} aria-hidden="true" /><h3>{query ? '没有符合条件的素材' : `${experienceModeLabel(mode)} 暂无素材`}</h3><p>{query ? '试试其他名称或说明关键词。' : '上传此模式的素材并启用后，即可在大屏体验。'}</p>{query && <button className="ex-button" onClick={() => setQuery('')}>清空搜索</button>}</div>}
    </div>
    {order.dragPreview && byId.get(order.dragPreview.id) && createPortal(<div className="ex-material-drag-preview" aria-hidden="true" style={{ left: order.dragPreview.x - order.dragPreview.offsetX, top: order.dragPreview.y - order.dragPreview.offsetY, width: order.dragPreview.width, height: order.dragPreview.height }}><img src={appUrl(byId.get(order.dragPreview.id)!.image)} alt="" /></div>, document.body)}
    {order.dropIndicator && createPortal(<div className="ex-material-drop-indicator" aria-hidden="true" style={{ left: order.dropIndicator.left, top: order.dropIndicator.top, height: order.dropIndicator.height }} />, document.body)}
  </div>;
}
