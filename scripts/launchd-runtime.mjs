import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, cp, lstat, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

// launchd cannot depend on Terminal's permission to read Desktop or Documents.
// Its executable, application files, configuration, data and logs all live in
// Application Support. The downloadable source remains a separate copy.
export function previewRuntime(root, { home = homedir() } = {}) {
  const id = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 10);
  const directory = resolve(home, 'Library/Application Support/Miror/preview', id);
  return {
    directory,
    app: resolve(directory, 'app'),
    node: resolve(directory, 'bin/node'),
    data: resolve(directory, 'data'),
    environment: resolve(directory, 'environment.env'),
    logs: resolve(directory, 'logs'),
    prefix: `local.miror.preview.${id}`,
  };
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function installNode(runtime, source) {
  await mkdir(dirname(runtime.node), { recursive: true, mode: 0o700 });
  const metadata = resolve(runtime.directory, 'node-source.json');
  const info = await stat(source);
  const desired = JSON.stringify({ size: info.size, modified: info.mtimeMs, version: process.versions.node });
  let installed;
  try { installed = await readFile(metadata, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (installed === desired && await exists(runtime.node) && (await stat(runtime.node)).size === info.size) return;
  const temporary = `${runtime.node}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary);
    await chmod(temporary, 0o755);
    await rename(temporary, runtime.node);
    const temporaryMetadata = `${metadata}.${randomUUID()}.tmp`;
    await writeFile(temporaryMetadata, desired, { mode: 0o600 });
    await rename(temporaryMetadata, metadata);
  } finally { await rm(temporary, { force: true }); }
}

/** Refresh executable files only while this package's jobs are stopped. */
export async function prepareLaunchRuntime(root, options = {}) {
  root = resolve(root);
  const runtime = previewRuntime(root, options);
  await mkdir(runtime.logs, { recursive: true, mode: 0o700 });
  await chmod(runtime.directory, 0o700);
  await chmod(runtime.logs, 0o700);
  await installNode(runtime, options.nodePath ?? process.execPath);

  // Runtime configuration and data become authoritative after first install.
  // Subsequent launches must not replace saved SKs, SQLite or mirror settings.
  if (!await exists(runtime.environment)) {
    await copyFile(resolve(root, '.env'), runtime.environment);
    await chmod(runtime.environment, 0o600);
  }
  if (!await exists(runtime.data)) {
    const stagingData = resolve(runtime.directory, `data-${randomUUID()}.tmp`);
    try {
      if (await exists(resolve(root, '.data'))) await cp(resolve(root, '.data'), stagingData, { recursive: true, dereference: true, preserveTimestamps: true });
      else await mkdir(stagingData, { mode: 0o700 });
      await chmod(stagingData, 0o700);
      await rename(stagingData, runtime.data);
    } finally { await rm(stagingData, { recursive: true, force: true }); }
  }

  const staging = resolve(runtime.directory, `app-${randomUUID()}.tmp`);
  const previous = resolve(runtime.directory, `app-${randomUUID()}.previous`);
  let movedPrevious = false;
  try {
    await mkdir(staging, { mode: 0o700 });
    for (const name of ['dist', 'server', 'src', 'shared', 'scripts', 'runtime', 'seed', 'node_modules']) {
      await cp(resolve(root, name), resolve(staging, name), { recursive: true, dereference: true, preserveTimestamps: true });
    }
    for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', '.env.example']) await copyFile(resolve(root, name), resolve(staging, name));
    // Vite copies public model assets into dist; inference still resolves their
    // source paths. Keep both paths inside the published application.
    await symlink('dist', resolve(staging, 'public'), 'dir');
    await symlink('../data', resolve(staging, '.data'), 'dir');
    await symlink('../environment.env', resolve(staging, '.env'), 'file');
    if (await exists(runtime.app)) { await rename(runtime.app, previous); movedPrevious = true; }
    try { await rename(staging, runtime.app); }
    catch (error) { if (movedPrevious) { await rename(previous, runtime.app); movedPrevious = false; } throw error; }
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (movedPrevious) await rm(previous, { recursive: true, force: true });
  }
  return runtime;
}
