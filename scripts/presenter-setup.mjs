import { spawnSync } from 'node:child_process';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { validatePresenterConfig } from './presenter-router.mjs';

export const DEFAULT_API_BASE = 'http://xuxin.local:10101/v1.1/api/exhibition';
export const SERVICE_NAME = 'miror-presenter.service';
export const RULE_NAME = '70-miror-presenter.rules';
const SOURCE_FILES = ['presenter-service.mjs', 'presenter-router.mjs', 'presenter-linux.py'];
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const cleanLabel = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 180);

export function parseSetupArgs(args) {
  const options = { prepareOnly: false, apiBaseUrl: DEFAULT_API_BASE };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--prepare-only') options.prepareOnly = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (['--config', '--api-base'].includes(argument)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} 缺少参数。`);
      options[argument === '--config' ? 'configPath' : 'apiBaseUrl'] = value;
    } else throw new Error(`未知参数：${argument}`);
  }
  return options;
}

/** Keep udev comparisons literal: wildcard syntax could grant another device access. */
export function stableDevicePath(binding) {
  const path = binding.linuxDevicePath ?? binding.byPath;
  if (typeof path !== 'string' || !/^\/dev\/input\/by-(?:path|id)\/[^/]+$/.test(path)
    || /[\x00-\x20\x7f"'\\*?\[\]|]/.test(path) || ['.', '..'].includes(basename(path))) {
    throw new Error(`${binding.id ?? '接收器'} 必须使用无通配符的 /dev/input/by-path/ 或 by-id/ 稳定链接；安装器不接受 event 编号。`);
  }
  return path;
}

export function makeUdevRules(bindings) {
  const lines = bindings.map(binding => {
    const link = stableDevicePath(binding).slice('/dev/'.length);
    if (!Number.isInteger(binding.vendorId) || binding.vendorId < 1 || binding.vendorId > 0xffff
      || !Number.isInteger(binding.productId) || binding.productId < 0 || binding.productId > 0xffff) {
      throw new Error('接收器 VID/PID 无效。');
    }
    const vendor = binding.vendorId.toString(16).padStart(4, '0');
    const product = binding.productId.toString(16).padStart(4, '0');
    return `SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_KEYBOARD}=="1", ATTRS{idVendor}=="${vendor}", ATTRS{idProduct}=="${product}", SYMLINK=="${link}", TAG+="uaccess"`;
  });
  return ['# Miror presenter: only the explicitly selected keyboard interfaces.', ...new Set(lines), ''].join('\n');
}

export function systemdQuote(value, { exec = false } = {}) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('服务路径含有不支持的控制字符。');
  let quoted = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  if (exec) quoted = quoted.replace(/\$/g, () => '$$');
  return `"${quoted}"`;
}

export function makeInstallPlan(config, { home = homedir(), nodePath = process.execPath, pythonPath = '/usr/bin/python3' } = {}) {
  const normalized = validatePresenterConfig(config);
  for (const binding of normalized.bindings) stableDevicePath(binding);
  const configDirectory = join(home, '.config', 'miror-presenter');
  const scripts = join(home, '.local', 'share', 'miror-presenter', 'scripts');
  const unitDirectory = join(home, '.config', 'systemd', 'user');
  const configPath = join(configDirectory, 'bindings.json');
  const helperPath = join(scripts, 'presenter-linux.py');
  const rulePath = join(configDirectory, RULE_NAME);
  const unitPath = join(unitDirectory, SERVICE_NAME);
  const path = [...new Set([dirname(pythonPath), '/usr/local/bin', '/usr/bin', '/bin'])].join(':');
  const unit = [
    '[Unit]', 'Description=Miror presenter receivers', 'After=network-online.target', '',
    '[Service]', 'Type=simple',
    `ExecStart=${[nodePath, join(scripts, 'presenter-service.mjs'), '--config', configPath, '--hid', helperPath].map(value => systemdQuote(value, { exec: true })).join(' ')}`,
    `WorkingDirectory=${systemdQuote(scripts)}`, `Environment=${systemdQuote(`PATH=${path}`)}`,
    'Restart=on-failure', 'RestartSec=5', 'TimeoutStopSec=10', 'KillMode=control-group',
    'UMask=0077', 'NoNewPrivileges=true', 'StandardOutput=journal', 'StandardError=journal', '',
    '[Install]', 'WantedBy=default.target', '',
  ].join('\n');
  return { config: normalized, configDirectory, scripts, unitDirectory, configPath, helperPath, rulePath, unitPath,
    unit, rules: makeUdevRules(normalized.bindings), nodePath, pythonPath };
}

function run(command, args, { inherit = false, allowFailure = false, timeout = 20_000 } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe', timeout });
  if (!allowFailure && (result.error || result.status !== 0)) {
    const details = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `退出码 ${result.status}`;
    throw new Error(`${command} ${args[0] ?? ''} 失败：${details}`);
  }
  return result;
}

export function parseHelperOutput(output, type) {
  const events = String(output).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const error = events.find(event => event.type === 'error');
  if (error) throw new Error(error.message || error.code || '接收器检查失败。');
  const event = events.find(event => event.type === type);
  if (!event) throw new Error(`接收器未返回 ${type} 检查结果。`);
  return event;
}

function listReceivers(pythonPath, helperPath, runCommand = run) {
  const result = runCommand(pythonPath, [helperPath, '--list']);
  const listing = parseHelperOutput(result.stdout, 'devices');
  if (!Array.isArray(listing.devices)) throw new Error('接收器列表格式无效。');
  return listing.devices.filter(device => device.bus === 'usb' && device.usagePage === 1 && device.usage === 6);
}

export function receiverBinding(device, mirrorId, index) {
  const path = (Array.isArray(device.byPath) && device.byPath[0])
    || (Array.isArray(device.byId) && device.byId[0]) || device.linuxDevicePath;
  const binding = { id: `pen-${index}`, mirrorId, vendorId: device.vendorId, productId: device.productId, linuxDevicePath: path,
    ...(device.phys ? { phys: device.phys } : {}), ...(device.uniq ? { uniq: device.uniq } : {}) };
  stableDevicePath(binding);
  return binding;
}

async function chooseInteractive({ apiBaseUrl, pythonPath, helperPath }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('交互安装需要终端；也可通过 --config PATH 提供明确绑定。');
  const devices = listReceivers(pythonPath, helperPath).filter(device => {
    try { receiverBinding(device, 'validation-only', 1); return true; } catch { return false; }
  });
  if (new Set(devices.map(device => device.physicalDevicePath)).size < 2) throw new Error('请同时接入两只独立 USB 接收器；目前不足两只可绑定的外接接收器。');
  // Validate the URL before any network request, using a temporary valid selector.
  const checked = validatePresenterConfig({ apiBaseUrl, bindings: [receiverBinding(devices[0], 'validation-only', 1)] });
  const response = await fetch(`${checked.apiBaseUrl}/mirrors`, { signal: AbortSignal.timeout(5000), redirect: 'error', cache: 'no-store' });
  if (!response.ok) throw new Error(`无法读取后台设备列表（HTTP ${response.status}）。`);
  const listing = await response.json();
  const mirrors = Array.isArray(listing.mirrors) ? listing.mirrors.filter(mirror => typeof mirror.id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(mirror.id)) : [];
  if (new Set(mirrors.map(mirror => mirror.id)).size < 2) throw new Error('后台需要至少两台已建立的镜端设备。');
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const selectedDevices = new Set(); const selectedMirrors = new Set(); const bindings = [];
  const choose = async (items, label) => {
    for (;;) {
      const answer = (await readline.question(label)).trim();
      if (/^[1-9]\d*$/.test(answer) && Number(answer) <= items.length) return items[Number(answer) - 1];
      process.stdout.write(`请输入 1–${items.length}，没有默认选择。\n`);
    }
  };
  try {
    for (let index = 1; index <= 2; index++) {
      const choices = devices.filter(device => !selectedDevices.has(device.physicalDevicePath));
      process.stdout.write(`\n第 ${index} 支翻页笔：请选择它的接收器。列表也可能包含普通键盘，请按名称和 USB 路径辨认。\n`);
      choices.forEach((device, i) => process.stdout.write(`${i + 1}. ${cleanLabel(device.name)}  VID:PID ${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')}\n   ${receiverBinding(device, 'validation-only', index).linuxDevicePath}\n`));
      const device = await choose(choices, '接收器编号：');
      selectedDevices.add(device.physicalDevicePath);
      const screens = mirrors.filter(mirror => !selectedMirrors.has(mirror.id));
      screens.forEach((mirror, i) => process.stdout.write(`${i + 1}. ${cleanLabel(mirror.name ?? mirror.label ?? mirror.id)} (${mirror.id})\n`));
      const mirror = await choose(screens, '对应屏幕编号：');
      selectedMirrors.add(mirror.id);
      bindings.push(receiverBinding(device, mirror.id, index));
    }
  } finally { readline.close(); }
  return { apiBaseUrl: checked.apiBaseUrl, bindings };
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function preparePresenterFiles(plan, { sourceDirectory = scriptDirectory, stamp = new Date().toISOString().replace(/[:.]/g, '-') } = {}) {
  for (const file of SOURCE_FILES) await access(join(sourceDirectory, file), constants.R_OK);
  await mkdir(plan.configDirectory, { recursive: true, mode: 0o700 });
  await mkdir(plan.scripts, { recursive: true, mode: 0o755 });
  await mkdir(plan.unitDirectory, { recursive: true, mode: 0o755 });
  for (const target of [plan.configPath, plan.unitPath, plan.rulePath]) {
    if (await exists(target)) { await copyFile(target, `${target}.bak-${stamp}`); await chmod(`${target}.bak-${stamp}`, 0o600); }
  }
  for (const file of SOURCE_FILES) {
    const target = join(plan.scripts, file);
    if (resolve(sourceDirectory, file) !== resolve(target)) await copyFile(join(sourceDirectory, file), target);
    await chmod(target, file.endsWith('.py') ? 0o755 : 0o644);
  }
  const temporary = `${plan.configPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(plan.config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, plan.configPath);
  await writeFile(plan.unitPath, plan.unit, { mode: 0o644 });
  await writeFile(plan.rulePath, plan.rules, { mode: 0o600 });
  await chmod(plan.rulePath, 0o600);
}

/** Resolve exactly the selected links; never trigger or grant an entire input group. */
export async function boundEventNodes(config, devices, { resolvePath = realpath } = {}) {
  const physical = new Set(); const nodes = [];
  for (const binding of config.bindings) {
    let target;
    try { target = await resolvePath(stableDevicePath(binding)); }
    catch { throw new Error(`${binding.id} 未连接：${binding.linuxDevicePath}。请接回所选 USB 插口后重试安装。`); }
    const device = devices.find(item => item.eventPath === target);
    if (!/^\/dev\/input\/event\d+$/.test(target) || !device || device.vendorId !== binding.vendorId || device.productId !== binding.productId
      || (binding.phys && device.phys !== binding.phys) || (binding.uniq && device.uniq !== binding.uniq)) throw new Error(`${binding.id} 的实际接收器与配置不符，已保持服务停止。`);
    if (!device.physicalDevicePath || physical.has(device.physicalDevicePath)) throw new Error('两个绑定指向同一物理接收器，已保持服务停止。');
    physical.add(device.physicalDevicePath);
    nodes.push(`/sys/class/input/${basename(target)}`);
  }
  return nodes;
}

async function validateWithHelper(config, pythonPath, helperPath, runCommand) {
  const directory = await mkdtemp(join(tmpdir(), 'miror-presenter-validate-'));
  try {
    const configPath = join(directory, 'bindings.json');
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const result = runCommand(pythonPath, [helperPath, '--validate', configPath]);
    parseHelperOutput(result.stdout, 'valid');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function setupPresenter(options, {
  platform = process.platform, nodeVersion = process.versions.node, uid = process.getuid?.(),
  home = homedir(), sourceDirectory = scriptDirectory, runCommand = run,
  resolveDeviceNodes = boundEventNodes, selectBindings = chooseInteractive,
  print = message => process.stdout.write(message),
} = {}) {
  if (platform !== 'linux') throw new Error('此安装器仅用于 Ubuntu/Linux，请在连接两只接收器的展会电脑运行。');
  if (Number(nodeVersion.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或更高版本。');
  if (uid === 0) throw new Error('请用当前桌面登录用户运行安装器，不要在命令前加 sudo；安装器仅为自己的 udev 规则调用 sudo。');
  const python = runCommand('python3', ['-c', 'import sys; print(sys.executable)']);
  const pythonPath = python.stdout.trim();
  if (!pythonPath.startsWith('/')) throw new Error('未找到可用的 Python 3。');
  if (options.prepareOnly && !options.configPath) throw new Error('--prepare-only 需要 --config PATH，可离线准备明确配置。');
  const config = options.configPath ? JSON.parse(await readFile(resolve(options.configPath), 'utf8'))
    : await selectBindings({ ...options, apiBaseUrl: options.apiBaseUrl ?? DEFAULT_API_BASE, pythonPath, helperPath: join(sourceDirectory, 'presenter-linux.py') });
  const plan = makeInstallPlan(config, { home, pythonPath });
  if (options.prepareOnly && (await exists(plan.configPath) || await exists(plan.unitPath))) {
    throw new Error('--prepare-only 不会覆盖已有安装。请去掉 --prepare-only 执行正常安装，已有配置会先备份。');
  }
  // Pure validation precedes replacing existing bindings or stopping a service.
  await validateWithHelper(plan.config, pythonPath, join(sourceDirectory, 'presenter-linux.py'), runCommand);
  if (!options.prepareOnly) {
    runCommand('systemctl', ['--user', 'show-environment']);
    const loaded = runCommand('systemctl', ['--user', 'show', SERVICE_NAME, '--property=LoadState', '--value']);
    if (loaded.error || loaded.status !== 0 || !loaded.stdout?.trim()) throw new Error('无法确认现有翻页笔服务状态，未修改配置。请在本机桌面终端重试。');
    if (loaded.stdout.trim() !== 'not-found') runCommand('systemctl', ['--user', 'disable', '--now', SERVICE_NAME]);
  }
  await preparePresenterFiles(plan, { sourceDirectory });
  runCommand(pythonPath, [plan.helperPath, '--validate', plan.configPath]);
  print(`配置：${plan.configPath}\n服务：${plan.unitPath}\n权限规则：${plan.rulePath}\n`);
  if (options.prepareOnly) {
    print('文件已准备；未安装系统权限规则，未启用或启动服务。\n');
    return plan;
  }
  try {
    const nodes = await resolveDeviceNodes(plan.config, listReceivers(pythonPath, plan.helperPath, runCommand));
    print('安装所选接收器的访问规则（系统会请求管理员密码）。\n');
    runCommand('sudo', ['install', '--backup=numbered', '-m', '0644', '--', plan.rulePath, `/etc/udev/rules.d/${RULE_NAME}`], { inherit: true, timeout: 0 });
    runCommand('sudo', ['udevadm', 'control', '--reload-rules'], { inherit: true });
    for (const node of nodes) runCommand('sudo', ['udevadm', 'trigger', '--action=change', node], { inherit: true });
    runCommand('udevadm', ['settle', '--timeout=10']);
    const checked = runCommand(pythonPath, [plan.helperPath, '--check', '--config', plan.configPath], { allowFailure: true });
    let permission;
    try { permission = parseHelperOutput(checked.stdout, 'permission'); }
    catch (error) { throw new Error(`输入访问检查失败：${error.message}`); }
    if (checked.status !== 0 || permission.status !== 'granted' || permission.connected !== plan.config.bindings.length) {
      throw new Error('并非所有所选接收器都已连接且可读。');
    }
    runCommand('systemctl', ['--user', 'daemon-reload']);
    runCommand('systemctl', ['--user', 'enable', '--now', SERVICE_NAME]);
    runCommand('systemctl', ['--user', 'is-active', '--quiet', SERVICE_NAME]);
  } catch (error) {
    runCommand('systemctl', ['--user', 'disable', '--now', SERVICE_NAME], { allowFailure: true });
    throw new Error(`${error.message}\n翻页笔服务保持停止。请在本机已登录的桌面终端运行，将两只接收器接回已选 USB 插口，再运行安装器。\n只读复查：${pythonPath} ${plan.helperPath} --check --config ${plan.configPath}\n权限规则：/etc/udev/rules.d/${RULE_NAME}`);
  }
  print('翻页笔服务已启用并启动。\n查看状态：systemctl --user status miror-presenter.service\n查看按键：journalctl --user -u miror-presenter.service -f\n');
  return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseSetupArgs(process.argv.slice(2));
    if (options.help) process.stdout.write('用法：node scripts/presenter-setup.mjs [--config PATH] [--api-base URL] [--prepare-only]\n无 --config 时，明确选择两只 USB 接收器及各自屏幕。--prepare-only 配合 --config 可离线准备文件。\n');
    else await setupPresenter(options);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
