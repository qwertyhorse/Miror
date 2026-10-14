import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '@playwright/test');

// All traffic is intercepted below. This checks a built UI against memory-only
// fixtures and never reaches the managed preview, XMAX or a physical camera.
const dist = path.resolve(process.env.SESSION_LIMIT_CHECK_DIST || 'dist');
const output = path.resolve(process.env.PROVIDER_CHECK_OUTPUT || 'artifacts/mirror-provider-browser-check');
const controlOrigin = 'http://xuminghong.local:10200';
const cameraOrigin = 'https://xuminghong.local:10202';
const controlUrl = `${controlOrigin}/v1.1/exhibition/control?mirror=default`;
const defaults = { credits: 30, expireSeconds: 120 };
const profiles = Object.fromEntries(['default','second'].map(id => [id, { revision: 0, active: 'xmax', desired: 'xmax', pending: false, accounts: { xmax: { configured: true }, decart: { configured: false } } }]));
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
    else if (state && suffix === '/provider-settings' && request.method() === 'GET') response = profiles[state.mirrorId];
    else if (state && suffix === '/provider-settings' && request.method() === 'PUT') {
      const input = request.postDataJSON(); const profile = profiles[state.mirrorId];
      assert.equal(input.expectedRevision, profile.revision); profile.revision++;
      if (input.apiKey) { assert.equal(input.apiKey, 'dct_fixture'); profile.accounts.decart.configured = true; }
      profile.desired = input.provider; profile.pending = state.phase === 'showcase';
      if (!profile.pending) profile.active = profile.desired;
      response = profile;
    }
    else if (state && suffix === '/provider-settings/verify' && request.method() === 'POST') response = { authenticated: true, generationStarted: false };
    else if (state && suffix === '/provider-settings/apply' && request.method() === 'POST') {
      const profile = profiles[state.mirrorId]; assert.equal(request.postDataJSON().expectedRevision, profile.revision);
      profile.active = profile.desired; profile.pending = false; profile.revision++; state.phase = 'idle'; state.revision++; response = profile;
    }
    else if (state && suffix === '/credentials' && request.method() === 'GET') response = { configured: false, editable: true, source: 'mirror', revision: 0, perSessionLimit: 30, region: 'global', hasUnconfirmedSession: false };
    else if (state && suffix === '/command' && request.method() === 'POST') {
      const input = request.postDataJSON();
      assert.equal(input.action, 'configure', 'Only settings configuration is permitted');
      assert.deepEqual(Object.keys(input).sort(), ['action', 'commandId', 'expectedRevision', 'sessionLimits']);
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

const secure = `${cameraOrigin}/v1.1/exhibition/control?mirror=default&credentialForm=1&parentOrigin=${encodeURIComponent(controlOrigin)}`;
try {
  await page.goto(secure, { waitUntil: 'domcontentloaded' });
  const section = page.getByRole('region', { name: '换装服务设置' }); await section.waitFor();
  await section.getByRole('combobox', { name: '换装服务' }).click();
  await page.getByRole('option', { name: 'Decart · Lucy VTON 3.6' }).click();
  await section.getByRole('textbox', { name: 'Decart API Key' }).count();
  await section.getByLabel('Decart API Key').fill('dct_fixture');
  await section.getByRole('button', { name: '保存服务', exact: true }).click();
  await section.getByText('已生效', { exact: true }).waitFor();
  assert.equal(profiles.default.active, 'decart'); assert.equal(await section.getByLabel('Decart API Key').inputValue(), '');
  report.checks.push('HTTPS form configures Decart and clears the secret input');
  await section.getByRole('button', { name: '验证连接' }).click(); await section.getByText('鉴权通过', { exact: true }).waitFor();
  report.checks.push('Credential verification does not start generation');
  await page.setViewportSize({ width: 390, height: 844 });
  const decartCapture = path.join(output, 'providers-decart-mobile.png'); await page.locator('.ex-mirror-credentials').screenshot({ path: decartCapture }); report.screenshots.push(decartCapture);
  states.default.phase = 'showcase'; states.default.revision++;
  await section.getByRole('combobox', { name: '换装服务' }).click(); await page.getByRole('option', { name: 'XMAX', exact: true }).click();
  await section.getByRole('button', { name: '保存服务', exact: true }).click();
  await section.getByText('已保存，下次开始生效', { exact: true }).waitFor(); assert.equal(profiles.default.active, 'decart');
  report.checks.push('Saving another provider during an experience leaves the active provider unchanged');
  await section.getByRole('button', { name: '停止并切换', exact: true }).click();
  await section.getByText('已切换', { exact: true }).waitFor(); assert.equal(profiles.default.active, 'xmax');
  assert.equal(profiles.default.accounts.decart.configured, true); assert.equal(profiles.second.accounts.decart.configured, false);
  report.checks.push('Explicit stop-and-switch changes provider without deleting either account or touching another mirror');
  for (const width of [1280,390]) {
    await page.setViewportSize({ width, height: 1000 });
    const file = path.join(output, `providers-${width}.png`); await page.locator('.ex-mirror-credentials').screenshot({ path: file }); report.screenshots.push(file);
    assert.ok((await section.boundingBox()).width <= width);
  }
  assert.equal(await page.evaluate(() => window.__sessionLimitCameraCalls), 0);
  assert.equal(report.unexpectedApi.length,0); assert.equal(report.pageErrors.length,0); assert.equal(report.consoleErrors.length,0);
  assert.equal(report.blockedExternal.length,0); assert.equal(report.blockedWebSockets.length,0);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { await writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2)); await browser.close(); }
console.log(JSON.stringify({ status: report.status, checks: report.checks.length, providerCalls: 0 }));
