import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '@playwright/test');

// All traffic is intercepted below. This checks a built UI against memory-only
// fixtures and never reaches the managed preview, XMAX or a physical camera.
const dist = path.resolve(process.env.SESSION_LIMIT_CHECK_DIST || 'dist');
const output = path.resolve(process.env.SESSION_LIMIT_CHECK_OUTPUT || 'artifacts/mirror-session-limits-browser-check');
const controlOrigin = 'http://xuminghong.local:10200';
const cameraOrigin = 'https://xuminghong.local:10202';
const controlUrl = `${controlOrigin}/v1.1/exhibition/control?mirror=default`;
const defaults = { credits: 30, expireSeconds: 120 };
const names = { default: '额度测试镜', second: '另一台测试镜' };
function makeState(mirrorId, limits) {
  return {
    mirrorId, revision: 1, phase: 'idle', experienceMode: 'clothx', selectedLookId: 'commute', displayedLookId: null,
    enabledLookIds: ['commute'],
    looks: [{ id: 'commute', name: '轻盈通勤', image: '/assets/exhibition/commute-cutout.png', mode: 'clothx', description: '', source: 'sample', palette: '', category: '', tags: [] }],
    categories: [], tags: [], sessionNumber: 1, generationNumber: 1, updatedAt: Date.now(), generationReadyAt: null,
    providerMode: 'xmax', live: null, logs: [], settings: { autoReturnSeconds: 90,
      uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 }, sessionLimits: structuredClone(limits) },
  };
}
const states = { default: makeState('default', defaults), second: makeState('second', { credits: 90, expireSeconds: 240 }) };
const report = { checkedAt: new Date().toISOString(), dist, target: controlUrl,
  isolation: 'Every request is fulfilled from local dist or in-memory fixtures; external requests and WebSockets are blocked. No camera, credential creation, generation, managed runtime data or real API mutation.',
  limitation: 'Checks browser layout, settings behavior and request payloads only. Does not prove backend persistence or continuous cloud renewal.',
  checks: [], configure: [], api: [], unexpectedApi: [], blockedExternal: [], blockedWebSockets: [], missingStatic: [], pageErrors: [], consoleErrors: [], screenshots: [] };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2' };

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1512, height: 1200 } });
await context.routeWebSocket(/.*/, socket => { report.blockedWebSockets.push(socket.url()); socket.close(); });
await context.route('**/*', async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (![controlOrigin, cameraOrigin].includes(url.origin)) { report.blockedExternal.push(url.href); return route.abort(); }
  const endpoint = url.pathname.replace(/^\/v1\.1(?=\/)/, '');
  if (endpoint.startsWith('/api/')) {
    report.api.push({ method: request.method(), path: endpoint });
    let response;
    const match = endpoint.match(/^\/api\/exhibition\/mirrors\/(default|second)(.*)$/);
    const state = match ? states[match[1]] : undefined;
    const suffix = match?.[2];
    if (endpoint === '/api/exhibition/native-identity' && request.method() === 'GET') response = { native: false };
    else if (endpoint === '/api/exhibition/mirrors' && request.method() === 'GET') response = { defaultMirrorId: 'default', mirrors: Object.values(states).map(value => ({ id: value.mirrorId,
      name: names[value.mirrorId], phase: value.phase, revision: value.revision, providerMode: 'xmax', updatedAt: value.updatedAt, binding: null })) };
    else if (state && suffix === '' && request.method() === 'GET') response = state;
    else if (state && suffix === '/changes' && request.method() === 'GET') {
      if (Number(url.searchParams.get('after')) === state.revision) await new Promise(resolve => setTimeout(resolve, 250));
      response = state;
    }
    else if (state && suffix === '/live/status' && request.method() === 'GET') response = { configured: false, mode: 'xmax', model: 'x2.0', providerRegion: 'global', perSessionLimit: 30, expireSeconds: 120, heartbeatTimeoutSeconds: 30, live: null };
    else if (state && suffix === '/credentials' && request.method() === 'GET') response = { configured: false, editable: true, source: 'mirror', revision: 0, perSessionLimit: 30, region: 'global', hasUnconfirmedSession: false };
    else if (state && suffix === '/command' && request.method() === 'POST') {
      const input = request.postDataJSON();
      assert.equal(input.action, 'configure', 'Only settings configuration is permitted');
      assert.deepEqual(Object.keys(input).sort(), ['action', 'expectedRevision', 'sessionLimits']);
      assert.equal(input.expectedRevision, state.revision, 'UI carries the current revision');
      assert.equal(state.phase, 'idle'); assert.equal(state.live, null);
      assert.ok(input.sessionLimits.credits === null || (Number.isSafeInteger(input.sessionLimits.credits) && input.sessionLimits.credits >= 1 && input.sessionLimits.credits <= 1_000_000));
      assert.ok(Number.isSafeInteger(input.sessionLimits.expireSeconds) && input.sessionLimits.expireSeconds >= (input.sessionLimits.credits === null ? 60 : 1) && input.sessionLimits.expireSeconds <= 86_400);
      report.configure.push({ mirrorId: state.mirrorId, ...structuredClone(input) });
      state.settings.sessionLimits = structuredClone(input.sessionLimits); state.revision++; state.updatedAt = Date.now(); response = state;
    } else {
      report.unexpectedApi.push({ method: request.method(), path: endpoint });
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Fixture blocks this endpoint' }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(response), headers: { 'Cache-Control': 'no-store' } });
  }
  if (endpoint === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
  const filename = endpoint === '/exhibition/control' ? path.join(dist, 'index.html') : path.resolve(dist, `.${endpoint}`);
  if (!filename.startsWith(`${dist}${path.sep}`)) return route.abort();
  try { return route.fulfill({ contentType: types[path.extname(filename)] || 'application/octet-stream', body: await readFile(filename), headers: { 'Cache-Control': 'no-store' } }); }
  catch { report.missingStatic.push(endpoint); return route.fulfill({ status: 404, body: 'Fixture file missing' }); }
});
await context.addInitScript(() => {
  window.__sessionLimitCameraCalls = 0;
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { window.__sessionLimitCameraCalls++; throw new Error('Camera forbidden in settings fixture'); };
});
const page = await context.newPage();
page.on('pageerror', error => report.pageErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
const form = page.getByRole('form', { name: '会话额度设置' });
const saveButton = form.getByRole('button', { name: '保存会话额度', exact: true });
async function verify(limits) {
  assert.equal(await form.getByRole('radio', { name: '指定额度', exact: true }).isChecked(), limits.credits !== null);
  assert.equal(await form.getByRole('radio', { name: '无限制（自动续接）', exact: true }).isChecked(), limits.credits === null);
  assert.equal(await form.locator('[name="expireSeconds"]').inputValue(), String(limits.expireSeconds));
  assert.equal(await form.locator('[name="expireSeconds"]').getAttribute('min'), limits.credits === null ? '60' : '1');
  assert.equal(await form.getByLabel(limits.credits === null ? '每段有效期（秒）' : '凭证有效期（秒）', { exact: true }).count(), 1);
  if (limits.credits === null) assert.equal(await form.locator('[name="credits"]').count(), 0);
  else assert.equal(await form.locator('[name="credits"]').inputValue(), String(limits.credits));
}
async function save(limits) {
  const before = report.configure.length;
  await saveButton.click();
  await form.locator('.ex-session-limit-saved').waitFor();
  assert.equal(report.configure.length, before + 1);
  assert.deepEqual(report.configure.at(-1).sessionLimits, limits);
  await verify(limits);
}
async function screenshot(filename) {
  const file = path.join(output, filename);
  await form.screenshot({ path: file }); report.screenshots.push(file);
}
try {
  await page.goto(controlUrl, { waitUntil: 'domcontentloaded' }); await form.waitFor();
  await verify(defaults); assert.equal(await saveButton.isDisabled(), true);
  report.checks.push('Default remains finite 30 credits / 120 seconds without automatic save');
  await form.locator('[name="credits"]').fill('75'); await form.locator('[name="expireSeconds"]').fill('900');
  await save({ credits: 75, expireSeconds: 900 });
  report.checks.push('Finite credits and expiry save atomically with the current revision');
  await form.getByRole('radio', { name: '无限制（自动续接）', exact: true }).check();
  await form.locator('[name="expireSeconds"]').fill('59');
  assert.equal(await saveButton.isDisabled(), true);
  assert.match(await form.getByRole('alert').innerText(), /60–86,400/);
  await form.locator('[name="expireSeconds"]').fill('60');
  await screenshot('session-limits-continuous-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('session-limits-continuous-mobile.png');
  assert.ok((await form.boundingBox()).width <= 390);
  await page.setViewportSize({ width: 1512, height: 1200 });
  await save({ credits: null, expireSeconds: 60 });
  await page.reload({ waitUntil: 'domcontentloaded' }); await form.waitFor(); await verify({ credits: null, expireSeconds: 60 });
  report.checks.push('Continuous mode explicitly submits null, enforces 60-second minimum and survives fixture reload');
  await form.getByRole('radio', { name: '指定额度', exact: true }).check();
  await form.locator('[name="credits"]').fill('90'); await form.locator('[name="expireSeconds"]').fill('300');
  await save({ credits: 90, expireSeconds: 300 });
  report.checks.push('Switching back to finite mode submits an explicit numeric limit');
  await form.getByRole('radio', { name: '无限制（自动续接）', exact: true }).check();
  states.default.settings.sessionLimits = { credits: 120, expireSeconds: 600 }; states.default.revision++;
  await form.getByRole('alert').filter({ hasText: '其他页面更新' }).waitFor({ timeout: 10000 });
  assert.equal(await saveButton.isDisabled(), true);
  await form.getByRole('button', { name: '取消修改', exact: true }).click(); await verify({ credits: 120, expireSeconds: 600 });
  report.checks.push('Conflicting remote settings cannot be overwritten by an old draft');
  await form.getByRole('radio', { name: '无限制（自动续接）', exact: true }).check();
  await page.getByRole('navigation', { name: '智能镜设备' }).getByRole('button', { name: new RegExp(names.second) }).click();
  await page.getByRole('heading', { name: names.second, exact: true }).waitFor(); await verify({ credits: 90, expireSeconds: 240 });
  await page.getByRole('navigation', { name: '智能镜设备' }).getByRole('button', { name: new RegExp(names.default) }).click();
  await page.getByRole('heading', { name: names.default, exact: true }).waitFor(); await verify({ credits: 120, expireSeconds: 600 });
  report.checks.push('Changing mirrors discards unsaved drafts and keeps each mirror settings independent');
  states.default.phase = 'showcase'; states.default.revision++;
  await page.waitForFunction(() => document.querySelector('.ex-session-limits input[name="credits"]')?.disabled, null, { timeout: 10000 });
  assert.equal(await form.getByRole('radio', { name: '无限制（自动续接）', exact: true }).isDisabled(), true);
  assert.equal(await saveButton.isDisabled(), true);
  states.default.phase = 'idle'; states.default.revision++;
  await page.waitForFunction(() => document.querySelector('.ex-session-limits input[name="credits"]')?.disabled === false, null, { timeout: 10000 });
  report.checks.push('An active experience disables all session-limit editing');
  await form.getByRole('button', { name: '恢复默认', exact: true }).click();
  await verify(defaults); assert.deepEqual(states.default.settings.sessionLimits, { credits: 120, expireSeconds: 600 });
  await save(defaults); await screenshot('session-limits-restored-defaults.png');
  assert.equal(await page.evaluate(() => window.__sessionLimitCameraCalls), 0);
  assert.equal(report.pageErrors.length, 0); assert.equal(report.consoleErrors.length, 0); assert.equal(report.unexpectedApi.length, 0); assert.equal(report.missingStatic.length, 0);
  assert.equal(report.blockedExternal.length, 0); assert.equal(report.blockedWebSockets.length, 0);
  assert.ok(report.api.filter(item => item.method !== 'GET').every(item => item.path.endsWith('/command')));
  assert.equal(report.configure.length, 4); assert.ok(report.configure.every(item => item.mirrorId === 'default'));
  report.checks.push('Restore is a finite draft until saved; all mutations remain in-memory configuration requests');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack;
  try { await screenshot('failure-session-limits.png'); } catch {}
  throw error;
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify({ status: report.status, checks: report.checks, configured: report.configure.length, output }, null, 2));
}
