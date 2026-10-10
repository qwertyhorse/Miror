import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// launchd must open its working directory and logs before Node can apply the
// user's Documents access permission. Keep those startup files in Library.
export function previewRuntime(root) {
  const id = createHash('sha256').update(root).digest('hex').slice(0, 10);
  const directory = resolve(homedir(), 'Library/Application Support/Miror/preview', id);
  return {
    directory,
    bootstrap: resolve(directory, 'bootstrap.mjs'),
    logs: resolve(directory, 'logs'),
    prefix: `local.miror.preview.${id}`,
  };
}

export async function prepareLaunchRuntime(root) {
  const runtime = previewRuntime(root);
  await mkdir(runtime.logs, { recursive: true, mode: 0o700 });
  await chmod(runtime.directory, 0o700);
  await chmod(runtime.logs, 0o700);
  const source = `// Enter the project from Node, which holds this user's file access permission.\nprocess.chdir(${JSON.stringify(resolve(root))});\n`;
  let installed;
  try { installed = await readFile(runtime.bootstrap, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (installed !== source) {
    const temporary = `${runtime.bootstrap}.${process.pid}.tmp`;
    await writeFile(temporary, source, { mode: 0o600 });
    await rename(temporary, runtime.bootstrap);
  }
  return runtime;
}
