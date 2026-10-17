import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const servicePath = fileURLToPath(new URL('./presenter-service.mjs', import.meta.url));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function eventually(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, message);
    await pause(20);
  }
}
async function lines(path) {
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function fixture(t, { mode = 'ready', available = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'miror-presenter-service-'));
  const startedPath = join(directory, 'started');
  const stoppedPath = join(directory, 'stopped');
  const restoredPath = join(directory, 'restored');
  const configPath = join(directory, 'bindings.json');
  const journalPath = `${configPath}.keymap-backup.json`;
  const hidPath = join(directory, 'fake-hid.mjs');
  const requests = [];
  const events = [];
  let child;
  let exit;
  let diagnostic = '';
  const api = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(available ? 200 : 503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ mirrors: [{ id: 'default' }] }));
  });
  t.after(async () => {
    if (child && exit === undefined) {
      child.kill('SIGKILL');
      await eventually(() => exit !== undefined, 'service did not exit during cleanup');
    }
    // Keep failing assertions from leaving an artificial receiver running.
    for (const value of await lines(startedPath)) {
      const pid = Number(value);
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
    api.closeAllConnections();
    await new Promise(resolve => api.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  await writeFile(configPath, JSON.stringify({
    apiBaseUrl: `http://127.0.0.1:${api.address().port}/v1.1/api/exhibition`,
    bindings: [{ id: 'pen-a', mirrorId: 'default', vendorId: 529, productId: 1, locationId: 100 }],
  }));
  await writeFile(hidPath, `#!/usr/bin/env node
import { appendFileSync, writeFileSync, unlinkSync } from 'node:fs';
const startedPath = ${JSON.stringify(startedPath)};
const stoppedPath = ${JSON.stringify(stoppedPath)};
const restoredPath = ${JSON.stringify(restoredPath)};
const journalPath = ${JSON.stringify(journalPath)};
const mode = ${JSON.stringify(mode)};
if (process.argv[2] === '--restore') {
  appendFileSync(restoredPath, JSON.stringify(process.argv.slice(2)) + '\\n');
  console.log(JSON.stringify({ type: 'key', bindingId: 'pen-a', usage: 78, value: 1 }));
  if (mode === 'crash-restore-failure') process.exit(1);
  unlinkSync(journalPath);
  process.exit(0);
}
appendFileSync(startedPath, process.pid + '\\n');
process.on('SIGTERM', () => {
  appendFileSync(stoppedPath, process.pid + '\\n');
  // Buffered input received during shutdown must not produce a new API request.
  console.log(JSON.stringify({ type: 'key', bindingId: 'pen-a', usage: 78, value: 1 }));
  setTimeout(() => process.exit(0), 25);
});
if (mode.startsWith('crash')) {
  writeFileSync(journalPath, JSON.stringify({ fake: true }));
  console.log(JSON.stringify({ type: 'ready', pid: process.pid }));
  setTimeout(() => process.exit(1), 25);
}
else if (mode === 'ready') console.log(JSON.stringify({ type: 'ready', pid: process.pid }));
else console.log(JSON.stringify({ type: 'error', code: mode === 'permission' ? 'input_monitoring_required' : 'ambiguous_receiver', message: 'test native failure' }));
setInterval(() => {}, 1000);
`);
  await chmod(hidPath, 0o700);
  child = spawn(process.execPath, [servicePath, '--config', configPath, '--hid', hidPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
  });
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    pending += chunk;
    const rows = pending.split('\n'); pending = rows.pop();
    for (const row of rows) {
      try { events.push(JSON.parse(row)); } catch { diagnostic += row; }
    }
  });
  child.stderr.on('data', chunk => { diagnostic += chunk; });
  child.on('error', error => { diagnostic += error.message; });
  child.on('close', (code, signal) => { exit = { code, signal }; });
  return {
    child, events, requests, startedPath, stoppedPath, restoredPath, journalPath, configPath,
    setAvailable(value) { available = value; },
    async waitExit() {
      await eventually(() => exit !== undefined, `service did not exit: ${diagnostic}`);
      return exit;
    },
  };
}

for (const mode of ['permission', 'fatal']) {
  test(`native ${mode} error releases its helper and exits cleanly without a retry loop`, { timeout: 10_000 }, async t => {
    const runtime = await fixture(t, { mode });
    assert.deepEqual(await runtime.waitExit(), { code: 0, signal: null });
    assert.equal(runtime.events.filter(event => event.type === 'error').length, 1);
    assert.equal(runtime.events.filter(event => event.type === 'hid-exit').length, 1);
    const pids = await lines(runtime.startedPath);
    assert.equal(pids.length, 1);
    assert.deepEqual(await lines(runtime.stoppedPath), pids);
    assert.equal(alive(Number(pids[0])), false);
    assert.ok(runtime.requests.every(path => path.endsWith('/mirrors')), 'shutdown input reached the command router');
  });
}

test('SIGTERM waits for helper shutdown and ignores its final buffered key', { timeout: 10_000 }, async t => {
  const runtime = await fixture(t);
  await eventually(() => runtime.events.some(event => event.type === 'ready'), 'helper did not start');
  runtime.child.kill('SIGTERM');
  assert.deepEqual(await runtime.waitExit(), { code: 0, signal: null });
  const pids = await lines(runtime.startedPath);
  assert.equal(pids.length, 1);
  assert.deepEqual(await lines(runtime.stoppedPath), pids);
  assert.equal(alive(Number(pids[0])), false);
  assert.ok(runtime.requests.every(path => path.endsWith('/mirrors')), 'shutdown input reached the command router');
});

test('an unavailable API leaves receivers alone, starts after recovery, and releases them on failure', { timeout: 15_000 }, async t => {
  const runtime = await fixture(t, { available: false });
  await eventually(() => runtime.requests.length > 0, 'service did not check the API');
  assert.deepEqual(await lines(runtime.startedPath), []);
  runtime.setAvailable(true);
  await eventually(() => runtime.events.some(event => event.type === 'ready'), 'helper did not start after API recovery');
  runtime.setAvailable(false);
  await eventually(() => runtime.events.some(event => event.type === 'hid-exit'), 'helper stayed active after API failure');
  const pids = await lines(runtime.startedPath);
  assert.equal(pids.length, 1);
  assert.deepEqual(await lines(runtime.stoppedPath), pids);
  assert.equal(alive(Number(pids[0])), false);
  assert.ok(runtime.requests.every(path => path.endsWith('/mirrors')), 'shutdown input reached the command router');
  runtime.child.kill('SIGTERM');
  assert.deepEqual(await runtime.waitExit(), { code: 0, signal: null });
});

test('a crashed helper with a mapping journal is restored before the service continues', { timeout: 10_000 }, async t => {
  const runtime = await fixture(t, { mode: 'crash' });
  await eventually(() => runtime.events.some(event => event.type === 'hid-exit'), 'helper exit and journal recovery did not finish');
  assert.deepEqual((await lines(runtime.restoredPath)).map(row => JSON.parse(row)), [['--restore', runtime.configPath]]);
  assert.deepEqual(await lines(runtime.journalPath), []);
  assert.ok(runtime.requests.every(path => path.endsWith('/mirrors')), 'restoration output reached the command router');
  runtime.child.kill('SIGTERM');
  assert.deepEqual(await runtime.waitExit(), { code: 0, signal: null });
  const pids = await lines(runtime.startedPath);
  assert.equal(pids.length, 1);
  assert.equal(alive(Number(pids[0])), false);
});

test('failed mapping recovery exits cleanly and preserves the recovery journal without restarting', { timeout: 10_000 }, async t => {
  const runtime = await fixture(t, { mode: 'crash-restore-failure' });
  assert.deepEqual(await runtime.waitExit(), { code: 0, signal: null });
  assert.ok(runtime.events.some(event => event.type === 'error' && event.code === 'keymap_restore_failed'));
  assert.deepEqual((await lines(runtime.restoredPath)).map(row => JSON.parse(row)), [['--restore', runtime.configPath]]);
  assert.equal((await lines(runtime.journalPath)).length, 1);
  assert.equal((await lines(runtime.startedPath)).length, 1);
  assert.ok(runtime.requests.every(path => path.endsWith('/mirrors')), 'restoration output reached the command router');
});
