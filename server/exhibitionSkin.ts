import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ExhibitionUiSkin } from '../shared/exhibition.ts';
import { ApiError } from './types.ts';

type PreparedSkin = { info: ExhibitionUiSkin; data: Buffer };
const WEBP_MAX_DIMENSION = 16_383;
const invalid = () => new ApiError('EXHIBITION_INVALID_SKIN', '请选择有效的图片。');
export class ExhibitionSkinStore {
  private readonly directory: string;
  constructor(dataDirectory: string, private readonly assetBasePath: string) {
    this.directory = join(dataDirectory, 'exhibition-skins');
  }
  async prepare(value: unknown): Promise<PreparedSkin> {
    if (typeof value !== 'string') throw invalid();
    const base64 = value.replace(/^data:image\/[^;,]+;base64,/iu, '');
    if (!base64 || base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) throw invalid();
    const bytes = Buffer.from(base64, 'base64');
    try {
      const { data, info } = await sharp(bytes, { failOn: 'warning', limitInputPixels: false })
        .rotate().resize({ width: WEBP_MAX_DIMENSION, height: WEBP_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 92, alphaQuality: 100 }).toBuffer({ resolveWithObject: true });
      return { info: { image: `${this.assetBasePath}/${randomUUID()}`, width: info.width, height: info.height, bytes: data.length }, data };
    } catch {
      throw invalid();
    }
  }
  install(prepared: PreparedSkin): ExhibitionUiSkin {
    const id = this.idFromImage(prepared.info.image);
    mkdirSync(this.directory, { recursive: true });
    const target = join(this.directory, `${id}.webp`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, prepared.data, { mode: 0o600 });
    renameSync(temporary, target);
    return structuredClone(prepared.info);
  }
  asset(id: string): { data: Buffer; mime: 'image/webp' } {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id)) throw new ApiError('EXHIBITION_SKIN_NOT_FOUND', '未找到 UI 皮肤。', 404);
    try { return { data: readFileSync(join(this.directory, `${id}.webp`)), mime: 'image/webp' }; }
    catch { throw new ApiError('EXHIBITION_SKIN_NOT_FOUND', '未找到 UI 皮肤。', 404); }
  }
  copyFrom(source: ExhibitionSkinStore, skin: ExhibitionUiSkin): ExhibitionUiSkin {
    const asset = source.asset(source.idFromImage(skin.image));
    return this.install({ info: { ...skin, image: `${this.assetBasePath}/${randomUUID()}`, bytes: asset.data.length }, data: asset.data });
  }
  private idFromImage(image: string): string {
    if (!image.startsWith(`${this.assetBasePath}/`)) throw invalid();
    const id = image.slice(this.assetBasePath.length + 1);
    if (!/^[a-f0-9-]{36}$/u.test(id)) throw invalid();
    return id;
  }
}
