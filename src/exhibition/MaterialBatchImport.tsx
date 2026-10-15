import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { exhibitionApiPath } from './mirrorApi';
import type { ExhibitionController } from './useExhibition';
import { parseMaterialManifest, type MaterialManifestItem } from './materialManifest';

function base64(file: File) { return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('文件读取失败')); reader.readAsDataURL(file); }); }
export function MaterialBatchImport({ controller }: { controller: ExhibitionController }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [manifest, setManifest] = useState<File | null>(null), [files, setFiles] = useState<File[]>([]);
  const [results, setResults] = useState<Record<string, string>>({});
  const successful = useRef(new Set<string>());
  const alive = useRef(true); const active = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); }; }, [controller.mirrorId]);
  const plan = useRef<MaterialManifestItem[] | null>(null);
  async function run() {
    if (!manifest || busy) return;
    const abort = new AbortController(); active.current = abort; const mirrorId = controller.mirrorId;
    setBusy(true); setError('');
    try {
      const nameOf = (file: File) => file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name;
      const names = files.map(nameOf);
      const items = plan.current ?? parseMaterialManifest(await manifest.text(), names);
      const categories = controller.state?.categories ?? [];
      for (const item of items) if (item.category && !categories.includes(item.category)) throw new Error(`${item.sku}：分类不存在`);
      const validation = await api<{ valid: boolean; items: Array<{ sku: string; errors: string[] }> }>(exhibitionApiPath('imports/validate', mirrorId), 'POST', { items, files: names }, abort.signal);
      if (!validation.valid) throw new Error(validation.items.filter(item => item.errors.length).map(item => `${item.sku}：${item.errors.join('、')}`).join('；'));
      // Decode every role before the first mutation, including retry batches.
      for (const file of files) { if (!/\.(jpe?g|png|webp)$/i.test(file.name) || !file.size || file.size > (controller.state?.settings.uploadLimits.maxFileSizeMB ?? 20) * 1024 * 1024) throw new Error(`图片无效：${file.name}`); const bitmap = await createImageBitmap(file); const limits = controller.state?.settings.uploadLimits; const valid = !limits || (bitmap.width >= limits.minWidth && bitmap.width <= limits.maxWidth && bitmap.height >= limits.minHeight && bitmap.height <= limits.maxHeight && bitmap.width * bitmap.height <= 32_000_000); bitmap.close(); if (!valid) throw new Error(`图片尺寸不符合限制：${file.name}`); }
      plan.current = items;
      const byName = new Map(files.map(file => [nameOf(file), file]));
      for (const item of items) {
        if (abort.signal.aborted || !alive.current) return;
        if (successful.current.has(item.sku)) continue;
        setResults(previous => ({ ...previous, [item.sku]: '导入中' }));
        try {
          await api(exhibitionApiPath('looks', mirrorId), 'POST', { sku: item.sku, name: item.name, mode: item.mode, category: item.category, prompt: item.prompt ?? '', description: '', imageBase64: await base64(byName.get(item.displayFile)!), referenceImageBase64: await base64(byName.get(item.referenceFile)!) }, abort.signal);
          if (abort.signal.aborted || !alive.current) return;
          successful.current.add(item.sku); setResults(previous => ({ ...previous, [item.sku]: '草稿已保存' }));
        } catch (cause) { if (abort.signal.aborted || !alive.current) return; setResults(previous => ({ ...previous, [item.sku]: cause instanceof Error ? cause.message : '导入失败' })); }
      }
      await controller.refresh();
    } catch (cause) { if (abort.signal.aborted || !alive.current) return; setError(cause instanceof Error ? cause.message : '导入失败'); }
    finally { if (alive.current) setBusy(false); if (active.current === abort) active.current = null; }
  }
  const complete = !!plan.current?.length && plan.current.every(item => successful.current.has(item.sku));
  function reset() { plan.current = null; successful.current.clear(); setResults({}); setError(''); }
  return <><button className="ex-button" disabled={!controller.connected} onClick={() => setOpen(true)}>批量导入</button>{open && <div className="ex-batch-import" role="region" aria-label="批量导入素材">
    <label>清单 CSV<input aria-label="素材清单 CSV" type="file" accept=".csv,text/csv" disabled={busy} onChange={event => { reset(); setManifest(event.target.files?.[0] ?? null); }} /></label>
    <label>配对图片<input aria-label="批量展示图和模型参考图" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy} onChange={event => { reset(); setFiles(Array.from(event.target.files ?? [])); }} /></label>
    <label>素材文件夹<input aria-label="素材文件夹" type="file" multiple {...{ webkitdirectory: '' }} disabled={busy} onChange={event => { reset(); setFiles(Array.from(event.target.files ?? []).filter(file => /\.(jpe?g|png|webp)$/i.test(file.name))); }} /></label>
    <button className="ex-button ex-primary" disabled={busy || complete || !manifest || !files.length} onClick={() => void run()}>{busy ? '导入中…' : complete ? '导入完成' : Object.keys(results).length ? '重试失败项' : '校验并导入草稿'}</button>
    <button className="ex-button" disabled={busy} onClick={() => setOpen(false)}>关闭</button>
    {error && <p role="alert" className="ex-field-error">{error}</p>}
    <ul aria-live="polite">{Object.entries(results).map(([sku, result]) => <li key={sku}>{sku} · {result}</li>)}</ul>
  </div>}</>;
}
