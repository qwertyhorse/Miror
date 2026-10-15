import { EXHIBITION_EXPERIENCE_MODES, EXHIBITION_FREE_PROMPT_MAX_LENGTH, type ExhibitionExperienceMode } from '../../shared/exhibition';
export interface MaterialManifestItem { sku: string; name: string; mode: ExhibitionExperienceMode; category: string; displayFile: string; referenceFile: string; prompt?: string; }
/** Strict quoted CSV; identity always comes from the manifest SKU and exact path. */
export function parseMaterialManifest(text: string, files: string[]): MaterialManifestItem[] {
  const rows: string[][] = []; let row: string[] = [], value = '', quoted = false, closedQuote = false;
  text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { value += '"'; i++; } else { quoted = false; closedQuote = true; } }
      else value += c;
    } else if (c === ',' || c === '\n') {
      row.push(value.trim()); value = ''; closedQuote = false;
      if (c === '\n') { if (row.some(Boolean)) rows.push(row); row = []; }
    } else if (c === '"') { if (value || closedQuote) throw new Error('清单引号格式无效'); quoted = true; }
    else { if (closedQuote && c.trim()) throw new Error('清单引号后存在多余内容'); value += c; }
  }
  if (quoted) throw new Error('清单引号未闭合');
  row.push(value.trim()); if (row.some(Boolean)) rows.push(row);
  const headers = rows.shift() ?? [];
  const required = ['sku', 'name', 'mode', 'category', 'display_file', 'reference_file'];
  if (new Set(headers).size !== headers.length || required.some(key => !headers.includes(key))) throw new Error('清单需要唯一的 sku/name/mode/category/display_file/reference_file 列');
  if (!rows.length || rows.length > 100) throw new Error('每批需要 1–100 件素材');
  const seen = new Set<string>(); const counts = new Map<string, number>(); files.forEach(name => counts.set(name, (counts.get(name) ?? 0) + 1));
  return rows.map((cells, index) => {
    if (cells.length !== headers.length) throw new Error(`第 ${index + 2} 行列数不符`);
    const get = (key: string) => cells[headers.indexOf(key)] ?? '';
    const sku = get('sku').normalize('NFC'), mode = get('mode'), prompt = get('prompt');
    if (!sku || seen.has(sku)) throw new Error(`第 ${index + 2} 行 SKU 为空或重复`); seen.add(sku);
    if (!EXHIBITION_EXPERIENCE_MODES.includes(mode as ExhibitionExperienceMode)) throw new Error(`${sku}：模式无效`);
    if (mode === 'free' && (!prompt || prompt.length > EXHIBITION_FREE_PROMPT_MAX_LENGTH)) throw new Error(`${sku}：Free 需要有效 prompt`);
    const displayFile = get('display_file'), referenceFile = get('reference_file');
    for (const file of [displayFile, referenceFile]) if (!file || counts.get(file) !== 1) throw new Error(`${sku}：文件缺失或重名 ${file}`);
    return { sku, name: get('name') || sku, mode: mode as ExhibitionExperienceMode, category: get('category'), displayFile, referenceFile, ...(prompt ? { prompt } : {}) };
  });
}
