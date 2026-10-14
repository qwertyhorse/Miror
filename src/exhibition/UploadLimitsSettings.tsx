import { useEffect, useState, type FormEvent } from 'react';
import { Check, ImageUp } from 'lucide-react';
import { EXHIBITION_DEFAULT_UPLOAD_LIMITS, type ExhibitionUploadLimits } from '../../shared/exhibition';
import type { ExhibitionController } from './useExhibition';

const fields: { key: keyof ExhibitionUploadLimits; label: string; min: number; max: number }[] = [
  { key: 'maxFileSizeMB', label: '文件上限（MB）', min: 1, max: 20 },
  { key: 'minWidth', label: '最小宽度（px）', min: 64, max: 8192 },
  { key: 'maxWidth', label: '最大宽度（px）', min: 64, max: 8192 },
  { key: 'minHeight', label: '最小高度（px）', min: 64, max: 8192 },
  { key: 'maxHeight', label: '最大高度（px）', min: 64, max: 8192 },
];

export function UploadLimitsSettings({ controller }: { controller: ExhibitionController }) {
  const { state, send, connected, pending } = controller;
  const limits = state?.settings.uploadLimits ?? EXHIBITION_DEFAULT_UPLOAD_LIMITS;
  const limitsKey = JSON.stringify(limits);
  const [values, setValues] = useState(limits);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [baseline, setBaseline] = useState<number | undefined>();
  useEffect(() => { if (!dirty) setValues(JSON.parse(limitsKey)); }, [limitsKey, dirty]);
  if (!state) return null;
  const disabled = pending || !connected || !['idle', 'select'].includes(state.phase);
  async function save(event: FormEvent) {
    event.preventDefault(); setError(''); setSaved(false);
    if (values.minWidth > values.maxWidth || values.minHeight > values.maxHeight) {
      setError('最小尺寸不能大于最大尺寸。'); return;
    }
    if (await send({ action: 'configure', uploadLimits: values, expectedRevision: baseline })) { setDirty(false); setBaseline(undefined); setSaved(true); }
  }
  return <form className="ex-settings-group ex-upload-rules" onSubmit={event => void save(event)}>
    <h3><ImageUp size={17} /> 素材上传限制</h3>
    <p>支持 JPG、PNG、WebP 静态图片。以下限制对后续上传生效，已有素材保留。后台会重新校验图片内容与尺寸。</p>
    <fieldset disabled={disabled} className="ex-rules-fields">
      {fields.map(field => <label key={field.key}>{field.label}<input required type="number" min={field.min} max={field.max} step="1" value={Number.isNaN(values[field.key]) ? '' : values[field.key]} onChange={event => { if (!dirty) setBaseline(state.revision); setDirty(true); setValues({ ...values, [field.key]: event.target.valueAsNumber }); setSaved(false); }} /></label>)}
    </fieldset>
    <p className="ex-form-note">MB 按 1024 × 1024 字节计算。单张图片总像素最多 3200 万；文件上限可设 1–20 MB，宽高可设 64–8192 px。</p>
    {error && <p className="ex-field-error" role="alert">{error}</p>}
    <div className="ex-form-row"><button className="ex-button ex-primary" disabled={disabled}>保存上传限制</button>{dirty && <button type="button" className="ex-button" onClick={() => { setDirty(false); setBaseline(undefined); setError(''); }}>放弃修改，读取最新规则</button>}{saved && <span className="ex-saved" role="status"><Check size={16} />上传限制已保存</span>}</div>
  </form>;
}
