import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareLaunchRuntime, previewRuntime } from './launchd-runtime.mjs';
import { ensureManagedRuntime, managedPlist, managedUnits } from './lan-managed.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));

test('managed runtime survives loss of Desktop source and retains saved data and environment across refresh', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'openbuy-managed-runtime-'));
  const home = resolve(temporary, 'test home');
  const source = resolve(home, 'Desktop/独立会展');
  const options = { home };
  try {
    for (const name of ['dist', 'server', 'shared', 'scripts', 'seed', 'node_modules/tsx/dist', '.data/lan-tls']) await mkdir(resolve(source, name), { recursive: true });
    for (const name of ['package.json', 'package-lock.json']) await writeFile(resolve(source, name), '{"type":"module"}');
    await writeFile(resolve(source, '.env'), 'XMAX_API_KEY=initial-fixture\nOPENBUY_DATA_DIR=.data\n');
    await writeFile(resolve(source, '.env.example'), 'XMAX_API_KEY=\n');
    await writeFile(resolve(source, '.data/exhibition.json'), '{"revision":1}');
    await writeFile(resolve(source, '.data/lan-tls/root-ca.key'), 'fixture-ca-key');
    await writeFile(resolve(source, 'dist/index.html'), '<html>independent production page</html>');
    await writeFile(resolve(source, 'node_modules/dependency.js'), 'export default 42;');
    for (const name of ['server/index.ts', 'scripts/lan-preview.mjs', 'scripts/camera-https.mjs', 'scripts/setup.mjs', 'node_modules/tsx/dist/loader.mjs']) await writeFile(resolve(source, name), '// runtime fixture');
    await symlink('../node_modules/dependency.js', resolve(source, 'shared/dependency.js'));
    for (const name of ['static-web.mjs', 'gateway-shared.mjs']) await copyFile(resolve(scripts, name), resolve(source, 'scripts', name));
    await writeFile(resolve(source, 'scripts/probe.mjs'), `
      import http from 'node:http';
      import { readFile } from 'node:fs/promises';
      import dependency from '../shared/dependency.js';
      import { createStaticRequestHandler } from './static-web.mjs';
      const server = http.createServer(createStaticRequestHandler());
      await new Promise(done => server.listen(0, '127.0.0.1', done));
      try {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/v1.1/exhibition/control');
        console.log(JSON.stringify({ code: response.status, page: await response.text(), node: process.execPath, cwd: process.cwd(), dependency,
          environment: await readFile('.env', 'utf8'), data: await readFile('.data/exhibition.json', 'utf8') }));
      } finally { await new Promise(done => server.close(done)); }
    `);
    const runtime = await ensureManagedRuntime(source, options);
    const nodeInfo = await stat(runtime.node);
    assert.equal(nodeInfo.mode & 0o777, 0o755);
    assert.equal((await stat(runtime.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(runtime.environment)).mode & 0o777, 0o600);
    assert.equal(await readlink(resolve(runtime.app, '.data')), '../data');
    assert.equal(await realpath(resolve(runtime.app, '.env')), await realpath(runtime.environment));
    assert.equal(await realpath(resolve(runtime.app, '.data')), await realpath(runtime.data));
    assert.equal(await readFile(resolve(runtime.data, 'lan-tls/root-ca.key'), 'utf8'), 'fixture-ca-key');

    // Routine restarts retain the published code, even when the source differs.
    await writeFile(runtime.environment, 'XMAX_API_KEY=saved-runtime-fixture\n');
    await writeFile(resolve(runtime.data, 'exhibition.json'), '{"revision":8}');
    await writeFile(resolve(runtime.data, 'lan-tls/root-ca.key'), 'saved-runtime-ca');
    await writeFile(resolve(source, '.env'), 'XMAX_API_KEY=stale-source-fixture\n');
    await writeFile(resolve(source, '.data/exhibition.json'), '{"revision":2}');
    await writeFile(resolve(source, '.data/lan-tls/root-ca.key'), 'stale-source-ca');
    await writeFile(resolve(source, 'dist/index.html'), '<html>refreshed production page</html>');
    await ensureManagedRuntime(source, options);
    assert.equal(await readFile(resolve(runtime.app, 'dist/index.html'), 'utf8'), '<html>independent production page</html>');
    // Explicit publication remains able to replace code without replacing data.
    await prepareLaunchRuntime(source, options);
    assert.equal((await stat(runtime.node)).ino, nodeInfo.ino, 'unchanged Node should not be recopied');
    assert.equal(await readFile(runtime.environment, 'utf8'), 'XMAX_API_KEY=saved-runtime-fixture\n');
    assert.equal(await readFile(resolve(runtime.data, 'exhibition.json'), 'utf8'), '{"revision":8}');
    assert.equal(await readFile(resolve(runtime.data, 'lan-tls/root-ca.key'), 'utf8'), 'saved-runtime-ca');
    assert.equal(await readFile(resolve(source, '.env'), 'utf8'), 'XMAX_API_KEY=stale-source-fixture\n', 'runtime must not copy secrets back into source');

    await rename(source, `${source}-unavailable`);
    assert.deepEqual(await ensureManagedRuntime(source, options), runtime, 'restart must not read the missing source package');
    const result = spawnSync(runtime.node, [resolve(runtime.app, 'scripts/probe.mjs')], { cwd: runtime.app, encoding: 'utf8', timeout: 10000, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout);
    assert.equal(actual.code, 200);
    assert.equal(actual.page, '<html>refreshed production page</html>');
    assert.equal(actual.node, await realpath(runtime.node));
    assert.equal(actual.cwd, await realpath(runtime.app));
    assert.equal(actual.dependency, 42, 'dependency symlinks must not refer back to source');
    assert.equal(actual.environment, 'XMAX_API_KEY=saved-runtime-fixture\n');
    assert.equal(actual.data, '{"revision":8}');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('an incomplete published runtime fails closed instead of being overwritten by an older source', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'openbuy-managed-incomplete-'));
  const source = resolve(temporary, 'source'); const options = { home: temporary };
  const runtime = previewRuntime(source, options);
  try {
    await mkdir(resolve(runtime.app, 'dist'), { recursive: true });
    await writeFile(resolve(runtime.app, 'dist/index.html'), 'published-new-version');
    await mkdir(runtime.data, { recursive: true });
    await writeFile(runtime.environment, 'saved-fixture');
    await writeFile(resolve(runtime.data, 'state.json'), 'saved-state');
    await assert.rejects(ensureManagedRuntime(source, options), /未从源码覆盖/);
    assert.equal(await readFile(resolve(runtime.app, 'dist/index.html'), 'utf8'), 'published-new-version');
    assert.equal(await readFile(runtime.environment, 'utf8'), 'saved-fixture');
    assert.equal(await readFile(resolve(runtime.data, 'state.json'), 'utf8'), 'saved-state');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('launchd jobs reference only Application Support executable and application paths', () => {
  const source = '/Users/fixture/Desktop/独立会展';
  const home = '/Users/fixture';
  const runtime = previewRuntime(source, { home });
  const units = managedUnits(runtime, resolve(home, 'Library/LaunchAgents'));
  assert.equal(units.length, 4);
  for (const unit of units) {
    const description = managedPlist(unit, runtime);
    assert.ok(description.includes(`<string>${runtime.node}</string>`));
    assert.ok(description.includes(`<key>WorkingDirectory</key><string>${runtime.app}</string>`));
    assert.ok(description.includes('<key>OPENBUY_DATA_DIR</key><string>.data</string>'));
    assert.ok(description.includes('<key>KeepAlive</key><true/>'));
    assert.ok(description.includes('<key>RunAtLoad</key><true/>'));
    assert.ok(!description.includes(source), 'launchd must never read Desktop or Documents');
    for (const argument of unit.args.filter(value => value.startsWith('/'))) assert.ok(argument.startsWith(`${runtime.app}/`));
  }
});
