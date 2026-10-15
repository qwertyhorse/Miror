import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { runNativeGestureContract } from '../tests/fixtures/nativeGestureContract.js';
import { androidGestureBundlePath } from './build-android-gesture.mjs';

const execute = promisify(execFile);
const chromium = process.argv[2];
if (!chromium) throw new Error('Pass the Chromium 74 executable path');
const version = (await execute(chromium, ['--version'])).stdout.trim();
if (!/Chrom(?:e|ium) 74\./.test(version)) throw new Error(`Expected actual Chromium 74, received ${version}`);
const temporary = await mkdtemp(join(tmpdir(), 'native-gesture-chromium74-'));
try {
  const script = await readFile(androidGestureBundlePath, 'utf8');
  const html = `<!doctype html><meta charset="utf-8"><body><script>${script}</script><script>
  try { document.body.textContent = 'GESTURE_RESULT:' + JSON.stringify((${runNativeGestureContract.toString()})(NativeGestureBundle.createNativeGestureRuntime)); }
  catch (error) { document.body.textContent = 'GESTURE_ERROR:' + error.stack; }
  </script></body>`;
  const fixture = join(temporary, 'check.html');
  await writeFile(fixture, html);
  const result = await execute(chromium, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-background-networking', '--disable-component-update', '--no-first-run',
    `--user-data-dir=${join(temporary, 'profile')}`, '--dump-dom', pathToFileURL(fixture).href], { timeout: 30_000 });
  const match = result.stdout.match(/GESTURE_RESULT:(\[[\s\S]*?\])<\/body>/);
  if (!match) throw new Error(`Chromium 74 gesture contract failed: ${result.stdout}`);
  const checks = JSON.parse(match[1]);
  if (checks.length !== 6) throw new Error('Incomplete Chromium 74 gesture contract');
  console.log(JSON.stringify({ browser: version, passed: checks }, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
