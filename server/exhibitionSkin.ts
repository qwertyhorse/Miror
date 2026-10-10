import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ExhibitionUiSkin } from '../shared/exhibition.ts';
import { ApiError } from './types.ts';

export const EXHIBITION_SKIN_MAX_BYTES = 8 * 1024 * 1024;
type PreparedSkin = { info: ExhibitionUiSkin; data: Buffer };
const invalid = () => new ApiError('EXHIBITION_INVALID_SKIN', '请选择有效的静态 PNG、JPG 或 WebP 图片。');
function isAnimatedPng(data: Buffer) {
  if (data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return false;
  for (let offset = 8; offset + 12 <= data.length;) {
    const length = data.readUInt32BE(offset);
    if (data.toString('ascii', offset + 4, offset + 8) === 'acTL') return true;
    offset += 12 + length;
  }
  return false;
}
export class ExhibitionSkinStore {
  private readonly directory: string;
  constructor(dataDirectory: string, private readonly assetBasePath: string) {
    this.directory = join(dataDirectory, 'exhibition-skins');
  }
  async prepare(value: unknown): Promise<PreparedSkin> {
    if (typeof value !== 'string') throw invalid();
    const base64 = value.replace(/^data:image\/(?:png|jpeg|webp);base64,/u, '');
    if (base64.length > Math.ceil(EXHIBITION_SKIN_MAX_BYTES / 3) * 4) throw new ApiError('EXHIBITION_SKIN_TOO_LARGE', 'UI 皮肤图片不能超过 8 MB。', 413);
    if (!base64 || base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) throw invalid();
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > EXHIBITION_SKIN_MAX_BYTES) throw new ApiError('EXHIBITION_SKIN_TOO_LARGE', 'UI 皮肤图片不能超过 8 MB。', 413);
    const png = bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!(png || jpeg || webp) || isAnimatedPng(bytes)) throw invalid();
    try {
      const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: 2160 * 3840 });
      const meta = await decoder.metadata();
      if (!['png', 'jpeg', 'webp'].includes(meta.format ?? '') || (meta.pages ?? 1) > 1) throw invalid();
      const swap = [5, 6, 7, 8].includes(meta.orientation ?? 0);
      const width = swap ? meta.height : meta.width;
      const height = swap ? meta.width : meta.height;
      if (!width || !height || width < 360 || height < 640 || width > 2160 || height > 3840 || width / height < .45 || width / height > .75) {
        throw new ApiError('EXHIBITION_INVALID_SKIN_DIMENSIONS', '请使用竖屏图片，建议 1080 × 1920，尺寸范围 360 × 640 至 2160 × 3840。');
      }
      const data = await decoder.rotate().webp({ quality: 92, alphaQuality: 100 }).toBuffer();
      return { info: { image: `${this.assetBasePath}/${randomUUID()}`, width, height, bytes: data.length }, data };
    } catch (error) {
      if (error instanceof ApiError) throw error;
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
