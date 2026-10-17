import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_API_BASE, SERVICE_NAME, RULE_NAME, parseSetupArgs, stableDevicePath, makeUdevRules,
  systemdQuote, makeInstallPlan, receiverBinding, boundEventNodes, preparePresenterFiles, setupPresenter } from './presenter-setup.mjs';

const devices = [1, 2].map(index => ({ vendorId: 529, productId: 1, name: 'Ai Pointer', bus: 'usb', usagePage: 1, usage: 6,
  phys: `usb-0000:00:14.0-${index}/input0`, uniq: '', physicalDevicePath: `/sys/devices/usb1/1-${index}`,
  eventPath: `/dev/input/event${index + 3}`, byPath: [`/dev/input/by-path/pci-0000:00:14.0-usb-0:${index}:1.0-event-kbd`],
  byId: [`/dev/input/by-id/usb-pointer-${index}-event-kbd`] }));
const config = { apiBaseUrl: DEFAULT_API_BASE,
  bindings: [receiverBinding(devices[0], 'mirror-women', 1), receiverBinding(devices[1], 'mirror-men', 2)] };
const ok = stdout => ({ status: 0, stdout, stderr: '' });
const exists = async path => { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

async function fixture(t, { permission = { type: 'permission', status: 'granted', connected: 2, bindings: 2 },
  permissionExit = 0, loaded = 'not-found', loadStatus = 0, failValidation = false, selectBindings } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'miror-presenter-setup-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'home with spaces');
  const sourceDirectory = join(directory, 'source scripts');
  await mkdir(sourceDirectory, { recursive: true });
  for (const name of ['presenter-service.mjs', 'presenter-router.mjs', 'presenter-linux.py']) {
    await writeFile(join(sourceDirectory, name), name.endsWith('.py') ? '#!/usr/bin/env python3\n' : 'export {};\n');
  }
  const configPath = join(directory, 'chosen bindings.json');
  await writeFile(configPath, JSON.stringify(config));
  const calls = []; const messages = []; const validated = []; const resolutions = [];
  const runCommand = (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === 'python3' && args[0] === '-c') return ok('/usr/bin/python3\n');
    if (command === '/usr/bin/python3' && args[1] === '--validate') {
      // Validate the actual supplied file, so /dev/stdin without input cannot silently pass.
      assert.notEqual(args[2], '/dev/stdin');
      validated.push(JSON.parse(readFileSync(args[2], 'utf8')));
      if (failValidation) throw new Error('helper rejected the configuration');
      return ok(JSON.stringify({ type: 'valid', bindings: config.bindings.length }) + '\n');
    }
    if (command === '/usr/bin/python3' && args[1] === '--list') return ok(JSON.stringify({ type: 'devices', devices }) + '\n');
    if (command === '/usr/bin/python3' && args[1] === '--check') return { ...ok(JSON.stringify(permission) + '\n'), status: permissionExit };
    if (command === 'systemctl' && args.includes('show')) return { ...ok(loaded + '\n'), status: loadStatus };
    if (['systemctl', 'sudo', 'udevadm'].includes(command)) return ok('');
    throw new Error(`Unexpected external command in fixture: ${command} ${args.join(' ')}`);
  };
  const dependencies = { platform: 'linux', nodeVersion: '24.0.0', uid: 1000, home, sourceDirectory, runCommand,
    resolveDeviceNodes: async (value, listing) => {
      resolutions.push({ value, listing });
      return ['/sys/class/input/event4', '/sys/class/input/event5'];
    },
    selectBindings: selectBindings ?? (async () => structuredClone(config)), print: value => messages.push(value) };
  return { directory, home, sourceDirectory, configPath, calls, messages, validated, resolutions, dependencies,
    run: (options = {}) => setupPresenter({ configPath, prepareOnly: false, ...options }, dependencies) };
}

test('setup defaults to the Ubuntu workstation and requires explicit option values', () => {
  assert.equal(parseSetupArgs([]).apiBaseUrl, 'http://xuxin.local:10101/v1.1/api/exhibition');
  assert.deepEqual(parseSetupArgs(['--prepare-only', '--config', '/tmp/selected.json']),
    { prepareOnly: true, apiBaseUrl: DEFAULT_API_BASE, configPath: '/tmp/selected.json' });
  for (const args of [['--config'], ['--api-base'], ['--config', '--prepare-only'], ['--force']]) assert.throws(() => parseSetupArgs(args));
});

test('two identical models keep separate physical paths and explicitly chosen mirror assignments', async () => {
  assert.deepEqual(config.bindings.map(binding => [binding.id, binding.mirrorId, binding.linuxDevicePath]), [
    ['pen-1', 'mirror-women', devices[0].byPath[0]], ['pen-2', 'mirror-men', devices[1].byPath[0]],
  ]);
  const plan = makeInstallPlan(config, { home: '/tmp/presenter-fixture' });
  const resolved = await boundEventNodes(plan.config, devices, {
    resolvePath: async path => devices.find(device => device.byPath.includes(path)).eventPath,
  });
  assert.deepEqual(resolved, ['/sys/class/input/event4', '/sys/class/input/event5']);
  assert.throws(() => makeInstallPlan({ ...config, bindings: [config.bindings[0], { ...config.bindings[1], mirrorId: 'mirror-women' }] }));
  assert.throws(() => makeInstallPlan({ ...config, bindings: [config.bindings[0], { ...config.bindings[1], linuxDevicePath: config.bindings[0].linuxDevicePath }] }));
});

test('different event aliases of one receiver cannot be assigned to two mirrors', async () => {
  const sameReceiver = [devices[0], { ...devices[1], physicalDevicePath: devices[0].physicalDevicePath }];
  await assert.rejects(boundEventNodes(config, sameReceiver, {
    resolvePath: async path => devices.find(device => device.byPath.includes(path)).eventPath,
  }), /同一物理接收器/);
});

test('missing and mismatched physical receivers fail before permission changes', async () => {
  await assert.rejects(boundEventNodes(config, devices, { resolvePath: async () => { throw new Error('missing'); } }), /未连接/);
  for (const change of [{ vendorId: 999 }, { productId: 5 }, { phys: 'another-port' }]) {
    const mismatched = [{ ...devices[0], ...change }, devices[1]];
    await assert.rejects(boundEventNodes(config, mismatched, {
      resolvePath: async path => devices.find(device => device.byPath.includes(path)).eventPath,
    }), /实际接收器与配置不符/);
  }
});

test('udev access is limited by exact stable interface path, USB IDs, and keyboard role', () => {
  const rules = makeUdevRules(config.bindings).split('\n').filter(line => line && !line.startsWith('#'));
  assert.equal(rules.length, 2);
  for (let index = 0; index < rules.length; index++) {
    assert.ok(rules[index].includes(`SYMLINK=="${devices[index].byPath[0].slice('/dev/'.length)}"`));
    assert.ok(rules[index].includes('SUBSYSTEM=="input"'));
    assert.ok(rules[index].includes('ENV{ID_INPUT_KEYBOARD}=="1"'));
    assert.ok(rules[index].includes('ATTRS{idVendor}=="0211"'));
    assert.ok(rules[index].includes('ATTRS{idProduct}=="0001"'));
    assert.ok(rules[index].endsWith('TAG+="uaccess"'));
    assert.doesNotMatch(rules[index], /MODE|GROUP|OWNER|RUN|666|usermod/);
  }
});

test('permission selectors reject wildcard, shell, udev-alternative and unstable event paths', () => {
  for (const path of ['/dev/input/event4', '/dev/input/by-path/*', '/dev/input/by-path/usb?', '/dev/input/by-path/[12]',
    '/dev/input/by-path/a|b', '/dev/input/by-path/a"b', '/dev/input/by-path/a\\b', '/dev/input/by-path/a b',
    '/dev/input/by-path/../event4', '/dev/input/by-path/.', '/tmp/event4']) {
    assert.throws(() => stableDevicePath({ id: 'pen-1', linuxDevicePath: path }), path);
    assert.throws(() => makeUdevRules([{ ...config.bindings[0], linuxDevicePath: path }]), path);
  }
});

test('systemd quoting preserves literal paths and escapes dollar expansion only in ExecStart', () => {
  assert.equal(systemdQuote('/opt/Tool ${node}%/node', { exec: true }), '"/opt/Tool $${node}%%/node"');
  assert.equal(systemdQuote('/opt/Tool ${node}%/node'), '"/opt/Tool ${node}%%/node"');
  assert.equal(systemdQuote('a"b\\c'), JSON.stringify('a"b\\c'));
  for (const value of ['line\nbreak', 'tab\there', 'nul\0here']) assert.throws(() => systemdQuote(value));
  const plan = makeInstallPlan(config, { home: '/tmp/Home ${person}% words',
    nodePath: '/opt/Node ${engine}%/node', pythonPath: '/opt/Python ${tool}%/python3' });
  const lines = plan.unit.split('\n');
  const execute = lines.find(line => line.startsWith('ExecStart='));
  assert.ok(execute.startsWith('ExecStart="/opt/Node $${engine}%%/node" '));
  assert.ok(execute.includes('"/tmp/Home $${person}%% words/.config/miror-presenter/bindings.json"'));
  assert.ok(lines.includes('WorkingDirectory="/tmp/Home ${person}%% words/.local/share/miror-presenter/scripts"'));
  assert.ok(lines.includes('Environment="PATH=/opt/Python ${tool}%%:/usr/local/bin:/usr/bin:/bin"'));
});

test('prepare-only validates actual config files and never invokes service, device, or permission operations', async t => {
  const f = await fixture(t);
  const plan = await f.run({ prepareOnly: true });
  assert.equal(f.validated.length, 2);
  assert.deepEqual(f.validated[0], plan.config);
  assert.deepEqual(f.validated[1], plan.config);
  assert.ok(f.calls.every(call => call.command === 'python3' || (call.command === '/usr/bin/python3' && call.args[1] === '--validate')));
  assert.equal(f.resolutions.length, 0);
  assert.deepEqual(JSON.parse(await readFile(plan.configPath, 'utf8')), plan.config);
  assert.equal((await stat(plan.configPath)).mode & 0o777, 0o600);
  assert.equal((await stat(plan.helperPath)).mode & 0o777, 0o755);
  assert.ok(f.messages.join('').includes('未启用或启动服务'));
  const initialValidation = f.calls.find(call => call.args[1] === '--validate');
  assert.equal(await exists(initialValidation.args[2]), false, 'temporary preflight config is cleaned up');
});

test('helper preflight failure cannot stop a service or replace existing configuration', async t => {
  const f = await fixture(t, { failValidation: true, loaded: 'loaded' });
  const plan = makeInstallPlan(config, { home: f.home });
  await mkdir(plan.configDirectory, { recursive: true });
  await writeFile(plan.configPath, 'original binding contents');
  await assert.rejects(f.run(), /helper rejected/);
  assert.equal(await readFile(plan.configPath, 'utf8'), 'original binding contents');
  assert.ok(!f.calls.some(call => ['sudo', 'systemctl', 'udevadm'].includes(call.command)));
  const validation = f.calls.find(call => call.args[1] === '--validate');
  assert.equal(validation.options.allowFailure, undefined);
  assert.equal(await exists(validation.args[2]), false);
});

test('prepare-only refuses an existing configuration or unit without altering files or service state', async t => {
  for (const field of ['configPath', 'unitPath']) {
    const f = await fixture(t);
    const plan = makeInstallPlan(config, { home: f.home });
    await mkdir(plan.configDirectory, { recursive: true });
    await mkdir(plan.unitDirectory, { recursive: true });
    await writeFile(plan[field], 'existing installation must stay intact');
    await assert.rejects(f.run({ prepareOnly: true }), /不会覆盖已有安装/);
    assert.equal(await readFile(plan[field], 'utf8'), 'existing installation must stay intact');
    assert.ok(!f.calls.some(call => ['sudo', 'systemctl', 'udevadm'].includes(call.command)));
    assert.equal(await exists(plan.scripts), false);
  }
});

test('an uncertain systemd LoadState cannot disable a service or replace its bindings', async t => {
  for (const response of [{ loaded: 'loaded', loadStatus: 1 }, { loaded: '' }]) {
    const f = await fixture(t, response);
    const plan = makeInstallPlan(config, { home: f.home });
    await mkdir(plan.configDirectory, { recursive: true });
    await writeFile(plan.configPath, 'old exact bindings');
    await assert.rejects(f.run(), /无法确认现有翻页笔服务状态/);
    assert.equal(await readFile(plan.configPath, 'utf8'), 'old exact bindings');
    assert.equal(await exists(plan.scripts), false);
    assert.ok(!f.calls.some(call => call.command === 'sudo' || call.command === 'udevadm'
      || (call.command === 'systemctl' && call.args.some(arg => ['disable', 'enable', 'start', 'stop'].includes(arg)))));
  }
});

test('preparation backs up bindings, unit and exact permission rules before replacing them', async t => {
  const f = await fixture(t);
  const plan = makeInstallPlan(config, { home: f.home });
  await mkdir(plan.configDirectory, { recursive: true });
  await mkdir(plan.unitDirectory, { recursive: true });
  const original = new Map([[plan.configPath, 'original config'], [plan.unitPath, 'original unit'], [plan.rulePath, 'original rules']]);
  for (const [path, body] of original) await writeFile(path, body);
  const unrelated = join(f.home, 'existing-mirror-history.json');
  await writeFile(unrelated, 'preserve history');
  await preparePresenterFiles(plan, { sourceDirectory: f.sourceDirectory, stamp: 'test-backup' });
  for (const [path, body] of original) {
    assert.equal(await readFile(`${path}.bak-test-backup`, 'utf8'), body);
    assert.equal((await stat(`${path}.bak-test-backup`)).mode & 0o777, 0o600);
  }
  assert.equal(await readFile(unrelated, 'utf8'), 'preserve history');
  assert.deepEqual(JSON.parse(await readFile(plan.configPath, 'utf8')), plan.config);
  assert.equal(await readFile(plan.unitPath, 'utf8'), plan.unit);
  assert.equal(await readFile(plan.rulePath, 'utf8'), plan.rules);
});

test('all connected permissions must pass before enabling the service; triggers target only selected nodes', async t => {
  const f = await fixture(t);
  const plan = await f.run();
  const permissionIndex = f.calls.findIndex(call => call.args[1] === '--check');
  const enableIndex = f.calls.findIndex(call => call.command === 'systemctl' && call.args.includes('enable'));
  assert.ok(permissionIndex >= 0 && enableIndex > permissionIndex);
  assert.deepEqual(f.calls.filter(call => call.command === 'sudo').map(call => call.args), [
    ['install', '--backup=numbered', '-m', '0644', '--', plan.rulePath, `/etc/udev/rules.d/${RULE_NAME}`],
    ['udevadm', 'control', '--reload-rules'],
    ['udevadm', 'trigger', '--action=change', '/sys/class/input/event4'],
    ['udevadm', 'trigger', '--action=change', '/sys/class/input/event5'],
  ]);
  assert.deepEqual(f.calls[enableIndex].args, ['--user', 'enable', '--now', SERVICE_NAME]);
  assert.equal(f.resolutions.length, 1);
  assert.deepEqual(f.resolutions[0].value.bindings, config.bindings);
});

test('partial, denied, missing, or failed permission checks never start the service', async t => {
  const cases = [
    { permission: { type: 'permission', status: 'granted', connected: 1, bindings: 2 } },
    { permission: { type: 'permission', status: 'unknown', connected: 2, bindings: 2 } },
    { permission: { type: 'permission', status: 'denied', connected: 2, bindings: 2 } },
    { permission: {} },
    { permission: { type: 'error', code: 'input_permission_required', message: 'access denied' }, permissionExit: 77 },
    { permission: { type: 'permission', status: 'granted', connected: 2, bindings: 2 }, permissionExit: 77 },
  ];
  for (const item of cases) {
    const f = await fixture(t, item);
    await assert.rejects(f.run(), /服务保持停止/);
    assert.ok(!f.calls.some(call => call.command === 'systemctl' && call.args.some(arg => ['enable', 'start', 'restart'].includes(arg))));
    assert.ok(f.calls.some(call => call.command === 'systemctl' && call.args.includes('disable') && call.args.includes('--now')));
  }
});

test('interactive selection preserves explicit pairings without guessing by model or device order', async t => {
  const selected = { ...config, bindings: [receiverBinding(devices[1], 'mirror-women', 1), receiverBinding(devices[0], 'mirror-men', 2)] };
  let asked = 0;
  const f = await fixture(t, { selectBindings: async request => {
    asked++;
    assert.equal(request.apiBaseUrl, DEFAULT_API_BASE);
    return selected;
  } });
  const plan = await f.run({ configPath: undefined });
  assert.equal(asked, 1);
  assert.deepEqual(plan.config.bindings, selected.bindings);
});
