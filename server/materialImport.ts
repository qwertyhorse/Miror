import { EXHIBITION_EXPERIENCE_MODES } from '../shared/exhibition.ts';
import { ApiError } from './types.ts';

/** Validate explicit roles before any bytes are decoded or a draft is written. */
export function validateMaterialImport(input: unknown) {
  if (!input || typeof input !== 'object') throw new ApiError('MATERIAL_IMPORT_INVALID', '请选择素材清单。');
  const { items, files } = input as Record<string, unknown>;
  if (!Array.isArray(items) || !items.length || items.length > 100 || !Array.isArray(files) || files.length > 200
    || !files.every(file => typeof file === 'string' && file.length > 0 && file.length <= 240)) throw new ApiError('MATERIAL_IMPORT_INVALID', '每批最多 100 件、200 个文件。');
  const available = new Set(files as string[]); const seen = new Set<string>();
  const results = items.map((raw, index) => {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const errors: string[] = []; const sku = typeof item.sku === 'string' ? item.sku.trim().normalize('NFC') : '';
    if (!sku || sku.length > 80 || /[\x00-\x1f\x7f]/u.test(sku)) errors.push('SKU 无效');
    if (seen.has(sku)) errors.push('SKU 重复'); seen.add(sku);
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 40) errors.push('名称无效');
    if (!EXHIBITION_EXPERIENCE_MODES.includes(item.mode as never)) errors.push('模式无效');
    if (item.mode === 'free' && (typeof item.prompt !== 'string' || !item.prompt.trim() || item.prompt.length > 1000)) errors.push('Free 提示词无效');
    if (item.category !== undefined && (typeof item.category !== 'string' || !item.category.trim() || item.category.length > 20)) errors.push('分类无效');
    for (const role of ['displayFile', 'referenceFile']) {
      if (typeof item[role] !== 'string' || !available.has(item[role] as string)) errors.push(role === 'displayFile' ? '缺少展示图' : '缺少参考图');
      else if ((files as string[]).filter(file => file === item[role]).length !== 1) errors.push('文件名重复');
    }
    return { index, sku, valid: errors.length === 0, errors };
  });
  return { valid: results.every(item => item.valid), items: results };
}
