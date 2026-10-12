import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seedRoot = join(packageRoot, 'seed');
const assetPath = /^exhibition-mirrors\/default\/exhibition-assets\/upload-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.webp$/u;
const allowedPath = path => path === 'exhibition-mirrors.json' || path === 'exhibition-mirrors/default/exhibition.json' || assetPath.test(path);
const digest = data => createHash('sha256').update(data).digest('hex');

function existingData(directory) {
  return ['exhibition-mirrors.json', 'exhibition.json', 'exhibition-mirrors'].find(name => existsSync(join(directory, name)));
}

function verifySeed() {
  const manifest = JSON.parse(readFileSync(join(seedRoot, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.mirrorCount !== 1 || manifest.lookCount !== 99 || !Array.isArray(manifest.files)) throw new Error('素材初始化清单无效。');
  const paths = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !allowedPath(file.path) || paths.has(file.path)) throw new Error('素材初始化路径无效。');
    paths.add(file.path);
    const filename = join(seedRoot, ...file.path.split('/'));
    if (!lstatSync(filename).isFile()) throw new Error(`素材文件无效：${file.path}`);
    const bytes = readFileSync(filename);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error(`素材文件校验失败：${file.path}`);
  }
  const registry = JSON.parse(readFileSync(join(seedRoot, 'exhibition-mirrors.json'), 'utf8'));
  if (registry.schemaVersion !== 1 || registry.defaultMirrorId !== 'default' || registry.mirrors?.length !== 1 || registry.mirrors[0].id !== 'default') throw new Error('默认智能镜配置无效。');
  const stored = JSON.parse(readFileSync(join(seedRoot, 'exhibition-mirrors/default/exhibition.json'), 'utf8'));
  const state = stored.state;
  if (stored.schemaVersion !== 3 || !state || state.mirrorId !== 'default' || state.phase !== 'idle' || state.providerMode !== 'demo'
    || state.live !== null || state.logs?.length !== 0 || state.sessionNumber !== 0 || state.generationNumber !== 0
    || state.revision !== 0 || state.updatedAt !== 0 || state.displayedLookId !== null || state.generationReadyAt !== null
    || state.autoSwitchAt !== null || stored.lastCommandAt !== 0 || stored.pausedPhase !== null || stored.pausedRemainingMs !== 0
    || state.settings?.uiSkin !== null || state.looks?.length !== 99) throw new Error('素材初始化状态无效。');
  const expected = new Set(['exhibition-mirrors.json', 'exhibition-mirrors/default/exhibition.json']);
  for (const look of state.looks) {
    const path = `exhibition-mirrors/default/exhibition-assets/${look.id}.webp`;
    if (!assetPath.test(path) || look.image !== `/api/exhibition/mirrors/default/assets/${look.id}` || look.source !== 'upload') throw new Error('素材引用无效。');
    expected.add(path);
  }
  if (expected.size !== 101 || paths.size !== expected.size || [...expected].some(path => !paths.has(path))) throw new Error('素材初始化文件不完整。');
  return { manifest, paths: [...paths] };
}

/** Install the optional bundled catalog before starting the API; existing data is never replaced. */
export function seedMaterials(options = {}) {
  const dataDirectory = resolve(packageRoot, options.dataDirectory ?? process.env.OPENBUY_DATA_DIR ?? '.data');
  const existing = existingData(dataDirectory);
  if (existing) return { installed: false, reason: 'existing-data', dataDirectory, existing };
  if (!existsSync(seedRoot)) return { installed: false, reason: 'seed-unavailable', dataDirectory };
  const { manifest, paths } = verifySeed();
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const staging = join(dataDirectory, `.seed-materials-${randomUUID()}`);
  const installedFiles = [];
  const installedDirectories = [];
  try {
    mkdirSync(staging, { mode: 0o700 });
    for (const path of paths) {
      const target = join(staging, ...path.split('/'));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(join(seedRoot, ...path.split('/')), target, constants.COPYFILE_EXCL);
    }
    const changed = existingData(dataDirectory);
    if (changed) return { installed: false, reason: 'existing-data', dataDirectory, existing: changed };
    // Exclusive directory creation also rejects a concurrent API initialization.
    const mirrorRoot = join(dataDirectory, 'exhibition-mirrors');
    mkdirSync(mirrorRoot, { mode: 0o700 });
    installedDirectories.push(mirrorRoot);
    const mirror = join(mirrorRoot, 'default');
    mkdirSync(mirror, { mode: 0o700 });
    installedDirectories.push(mirror);
    const assets = join(mirror, 'exhibition-assets');
    mkdirSync(assets, { mode: 0o700 });
    installedDirectories.push(assets);
    for (const path of paths.filter(path => path !== 'exhibition-mirrors.json')) {
      const target = join(dataDirectory, ...path.split('/'));
      copyFileSync(join(staging, ...path.split('/')), target, constants.COPYFILE_EXCL);
      installedFiles.push(target);
    }
    if (existsSync(join(dataDirectory, 'exhibition.json'))) throw new Error('检测到现有展会数据，已取消素材初始化。');
    const registryTarget = join(dataDirectory, 'exhibition-mirrors.json');
    copyFileSync(join(staging, 'exhibition-mirrors.json'), registryTarget, constants.COPYFILE_EXCL);
    installedFiles.push(registryTarget);
    return { installed: true, lookCount: manifest.lookCount, mirrorCount: 1, dataDirectory };
  } catch (error) {
    // Remove only paths created by this call; never recursively remove a user data directory.
    for (const filename of installedFiles.reverse()) rmSync(filename, { force: true });
    for (const directory of installedDirectories.reverse()) {
      try { if (readdirSync(directory).length === 0) rmdirSync(directory); } catch { /* Preserve unfamiliar data. */ }
    }
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--data-dir' || !args[1])) {
    console.error('用法：node scripts/seed-materials.mjs [--data-dir 数据目录]');
    process.exitCode = 1;
  } else {
    try {
      const result = seedMaterials(args.length ? { dataDirectory: args[1] } : {});
      console.log(result.installed ? `已导入 ${result.lookCount} 个展会预设素材。` : result.reason === 'existing-data' ? '检测到现有展会数据，已保留。' : '未附带可选素材库，跳过导入。');
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
