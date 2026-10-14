import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ExhibitionService } from '../server/exhibition';
import { ExhibitionMirrors } from '../server/exhibitionMirrors';
import { TryOnService } from '../server/service';
import { SecretBox, SessionStore } from '../server/store';
import type { ExhibitionLook } from '../shared/exhibition';
import type { Provider } from '../server/types';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const now = () => 1_800_000_000_000;
function storeService(store: SessionStore) {
  const unavailable = async (): Promise<never> => { throw new Error('Provider calls forbidden in asset tests'); };
  const provider: Provider = { configured: false, issueKey: unavailable, keyStatus: unavailable, deactivate: unavailable, sessionStatus: unavailable };
  return new TryOnService({ provider, store, secrets: new SecretBox(randomBytes(32)), catalog: async () => [] });
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'exhibition-durable-assets-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SessionStore(join(directory, 'sessions.sqlite'));
  cleanups.push(() => store.close());
  const service = storeService(store);
  const open = () => { const mirrors = new ExhibitionMirrors(directory, { now }); mirrors.attachLiveService(service); return mirrors; };
  return { directory, store, service, open, mirrors: open() };
}
async function picture(color: string) {
  return (await sharp({ create: { width: 512, height: 768, channels: 3, background: color } }).png().toBuffer()).toString('base64');
}
async function upload(mirror: ExhibitionService, name = '双图素材') {
  return (await mirror.upload({ name, imageBase64: await picture('#aa0000'), referenceImageBase64: await picture('#0000aa') })).looks.at(-1)!;
}
const urls = (look: ExhibitionLook) => [look.image, look.referenceImage!];
function asset(mirror: ExhibitionService, url: string) {
  const [id, role, token] = url.split('/assets/')[1].split('/');
  return mirror.assetResource(id, role, token).data;
}
const filename = (url: string) => url.split('/').slice(-3).join('.') + '.webp';
function failNextCommits(store: SessionStore) {
  // Fail after mirror_states is written, proving the real SQLite transaction rolls it back.
  store.db.exec("CREATE TEMP TRIGGER fail_asset_commit BEFORE INSERT ON mirror_events BEGIN SELECT RAISE(ABORT, 'fixture disk failure'); END");
  return () => store.db.exec('DROP TRIGGER fail_asset_commit');
}

describe('dual images with SQLite mirror state', () => {
  it('reloads the latest immutable pair from SQLite and retains the existing schema and upload-limit migrations', async () => {
    const f = fixture(); const mirror = f.mirrors.getMirror(); const look = await upload(mirror);
    const replacement = await picture('#00aa00');
    const next = (await mirror.updateLook(look.id, { imageBase64: replacement, expectedRevision: mirror.read().revision })).looks.at(-1)!;
    expect(next.referenceImage).toBe(look.referenceImage);
    const restored = f.open().getMirror();
    expect(restored.read()).toEqual(mirror.read());
    for (const url of urls(next)) expect(asset(restored, url)).toEqual(asset(mirror, url));
    expect(() => asset(restored, look.image)).toThrow();
    expect(f.store.mirrorState('default')).toMatchObject({ schemaVersion: 4, uploadLimitsVersion: 2,
      state: { settings: { uploadLimits: { minWidth: 256, maxWidth: 8192 } } } });
  });

  it('rolls back failed upload, replacement and deletion transactions without losing committed image files', async () => {
    const f = fixture(); const mirror = f.mirrors.getMirror(); const look = await upload(mirror);
    const before = mirror.read(); const durable = f.store.mirrorState('default');
    const oldBytes = urls(look).map(url => asset(mirror, url));
    const replacement = await picture('#00aa00'); const resume = failNextCommits(f.store);
    await expect(mirror.upload({ name: '失败上传', imageBase64: replacement, referenceImageBase64: replacement })).rejects.toThrow('fixture disk failure');
    await expect(mirror.updateLook(look.id, { imageBase64: replacement, referenceImageBase64: replacement })).rejects.toThrow('fixture disk failure');
    expect(() => mirror.removeLook(look.id, {})).toThrow('fixture disk failure');
    expect(mirror.read()).toEqual(before); expect(f.store.mirrorState('default')).toEqual(durable);
    expect(readdirSync(join(f.directory, 'exhibition-mirrors/default/exhibition-assets')).sort()).toEqual(urls(look).map(filename).sort());
    urls(look).forEach((url, index) => expect(asset(mirror, url)).toEqual(oldBytes[index]));
    resume(); expect(f.open().getMirror().read()).toEqual(before);
  });

  it('backs up authoritative SQLite content before copy and restores both images into an independent database', async () => {
    const f = fixture(); const source = f.mirrors.getMirror(); const original = await upload(source, '来源');
    const id = f.mirrors.create({ name: '目标' }).id; const target = f.mirrors.getMirror(id); const previous = await upload(target, '复制前');
    const before = target.read();
    const copied = f.mirrors.copy(id, { sourceMirrorId: 'default', copyLooks: true, copySettings: true, expectedRevision: before.revision }).looks.at(-1)!;
    expect(copied.id).not.toBe(original.id);
    urls(copied).forEach((url, index) => expect(asset(target, url)).toEqual(asset(source, urls(original)[index])));
    const latest = f.open().getMirror(id); expect(latest.read()).toEqual(target.read());
    const backups = join(f.directory, 'exhibition-mirrors', id, 'exhibition-copy-backups');
    const backup = join(backups, readdirSync(backups)[0]);
    expect(JSON.parse(readFileSync(join(backup, 'exhibition.json'), 'utf8')).state.looks.at(-1)).toEqual(previous);
    const restoredStore = new SessionStore(':memory:'); cleanups.push(() => restoredStore.close());
    const restored = new ExhibitionService(backup, { now, mirrorId: id, assetBasePath: `/api/exhibition/mirrors/${id}/assets`, strictStorage: true });
    restored.attachLiveService(storeService(restoredStore));
    expect(restored.read().looks).toEqual(before.looks);
    for (const url of urls(previous)) expect(asset(restored, url)).toEqual(readFileSync(join(backup, 'exhibition-assets', filename(url))));
    expect(restoredStore.mirrorState(id)).toMatchObject({ schemaVersion: 4, state: { looks: JSON.parse(JSON.stringify(before.looks)) } });
  });

  it('preserves the target and a complete recovery backup when a copied-state SQLite transaction fails', async () => {
    const f = fixture(); const source = f.mirrors.getMirror(); await upload(source);
    const id = f.mirrors.create({ name: '保留目标' }).id; const target = f.mirrors.getMirror(id); const look = await upload(target);
    const before = target.read(); const durable = f.store.mirrorState(id); const resume = failNextCommits(f.store);
    expect(() => f.mirrors.copy(id, { sourceMirrorId: 'default', copyLooks: true, copySettings: false, expectedRevision: before.revision })).toThrow('fixture disk failure');
    expect(target.read()).toEqual(before); expect(f.store.mirrorState(id)).toEqual(durable);
    const dir = join(f.directory, 'exhibition-mirrors', id);
    expect(readdirSync(join(dir, 'exhibition-assets')).sort()).toEqual(urls(look).map(filename).sort());
    const backup = join(dir, 'exhibition-copy-backups', readdirSync(join(dir, 'exhibition-copy-backups'))[0]);
    expect(JSON.parse(readFileSync(join(backup, 'exhibition.json'), 'utf8')).state.looks).toEqual(before.looks);
    urls(look).forEach(url => expect(readFileSync(join(backup, 'exhibition-assets', filename(url)))).toEqual(asset(target, url)));
    resume(); expect(f.open().getMirror(id).read()).toEqual(before);
  });
});
