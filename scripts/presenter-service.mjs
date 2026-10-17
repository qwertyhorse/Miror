import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPresenterRouter } from './presenter-router.mjs';

/** The HID child owns only configured receivers; the router never synthesizes keyboard events. */
export async function runPresenterService({ configPath, hidPath, fetchImpl = globalThis.fetch, log = event => {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
} }) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const router = createPresenterRouter(config, { fetchImpl, onEvent: log });
  let child = null;
  let accepting = false;
  let stopping = false;
  let checking = false;
  let timer;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const stopChild = () => {
    accepting = false;
    router.releaseAll();
    if (child) child.kill('SIGTERM');
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    stopChild();
    if (!child) finish(0);
  };
  const startChild = () => {
    if (child || stopping) return;
    const current = spawn(hidPath, ['--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    child = current;
    accepting = true;
    let fatalError = false;
    const input = createInterface({ input: current.stdout });
    input.on('line', line => {
      if (!accepting || stopping || child !== current) return;
      if (line.length > 8192) return;
      let event;
      try { event = JSON.parse(line); } catch { log({ type: 'invalid-hid-event' }); return; }
      if (event.type === 'error') {
        fatalError = true;
        log(event);
        stopChild();
        return;
      }
      if (event.type === 'key') {
        // Only key usages from the explicitly configured receiver enter the router.
        void router.handle(event).catch(() => log({ type: 'router-error', bindingId: event.bindingId }));
      } else {
        log(event);
        void router.handle(event).catch(() => undefined);
      }
    });
    const errors = createInterface({ input: current.stderr });
    errors.on('line', line => log({ type: 'hid-diagnostic', message: line.slice(0, 1024) }));
    current.on('error', error => log({ type: 'hid-error', message: error.message }));
    current.on('close', code => {
      input.close(); errors.close(); router.releaseAll();
      // The child normally restores its receiver mappings before exiting. A
      // crash leaves a journal; recover it in the same authorized node context.
      if (existsSync(`${configPath}.keymap-backup.json`)) {
        const restored = spawnSync(hidPath, ['--restore', configPath], { encoding: 'utf8', timeout: 3000 });
        if (restored.status !== 0) {
          fatalError = true;
          log({ type: 'error', code: 'keymap_restore_failed', message: '翻页笔按键映射恢复未完成，请重新连接接收器后重启服务。' });
        }
      }
      if (child === current) child = null;
      log({ type: 'hid-exit', code });
      // An operator must resolve native permission/configuration errors before retrying.
      // A clean exit prevents launchd from repeatedly prompting or seizing receivers.
      if (fatalError || code === 77 || code === 78) {
        stopping = true; clearInterval(timer); finish(0);
      } else if (stopping) finish(0);
    });
  };
  const check = async () => {
    if (checking || stopping) return;
    checking = true;
    try {
      const response = await fetchImpl(`${config.apiBaseUrl.replace(/\/$/, '')}/mirrors`, {
        signal: AbortSignal.timeout(2500), headers: { 'Cache-Control': 'no-store' },
      });
      if (!response.ok) throw new Error('API unavailable');
      const listing = await response.json();
      if (!config.bindings.every(binding => listing.mirrors?.some(mirror => mirror.id === binding.mirrorId)))
        throw new Error('A configured mirror is unavailable');
      if (!stopping) startChild();
    } catch {
      // A stopped LAN service must release the receivers to the operating system.
      if (child) { log({ type: 'api-offline' }); stopChild(); }
    } finally { checking = false; }
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  timer = setInterval(() => void check(), 3000);
  await check();
  const code = await done;
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
  const configPath = argument('--config'), hidPath = argument('--hid');
  if (!configPath || !hidPath) {
    console.error('Usage: node presenter-service.mjs --config PATH --hid PATH');
    process.exitCode = 64;
  } else {
    try { process.exitCode = await runPresenterService({ configPath, hidPath }); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
