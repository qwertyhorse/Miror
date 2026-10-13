import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const dist = path.resolve(process.env.GESTURE_CHECK_DIST || 'artifacts/mirror-settings-20261013/staging/dist');
const output = path.resolve(process.env.GESTURE_CHECK_OUTPUT || 'artifacts/mirror-gesture-settings-browser-check');
const controlOrigin = 'http://xuminghong.local:10200';
const cameraOrigin = 'https://xuminghong.local:10202';
const controlUrl = `${controlOrigin}/v1.1/exhibition/control?mirror=default`;
const screenUrl = `${cameraOrigin}/v1.1/exhibition/screen?mirror=default&diagnostics=1`;
const defaults = { gestures: ['open_palm'], minHandDetectionConfidence: .35, minHandPresenceConfidence: .35, minTrackingConfidence: .5, palmConfirmMs: 300, palmReleaseMs: 500, maxFps: 15, inputLongEdge: 720 };
const tuned = { gestures: ['open_palm', 'wave'], minHandDetectionConfidence: .28, minHandPresenceConfidence: .31, minTrackingConfidence: .47, palmConfirmMs: 250, palmReleaseMs: 400, maxFps: 10, inputLongEdge: 480 };
const state = {
  mirrorId: 'default', revision: 1, phase: 'idle', experienceMode: 'clothx', selectedLookId: 'commute', displayedLookId: null,
  enabledLookIds: ['commute', 'city', 'evening'],
  looks: [ ['commute', '轻盈通勤'], ['city', '都市休闲'], ['evening', '优雅礼服'] ].map(([id, name]) => ({ id, name, image: `/assets/exhibition/${id}-cutout.png`, mode: 'clothx', description: '', source: 'sample', palette: '', category: '', tags: [] })),
  categories: [], tags: [], sessionNumber: 1, generationNumber: 1, updatedAt: Date.now(), generationReadyAt: null,
  providerMode: 'xmax', live: null, logs: [],
  // Deliberately omit gestureRecognition: pre-feature mirrors must start palm-only.
  settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } },
};
const report = { checkedAt: new Date().toISOString(), dist, target: controlUrl, camera: 'Chrome fake camera; synthetic hand landmarks',
  isolation: 'Every request is fulfilled from local dist or in-memory fixtures. External requests and WebSockets are blocked. No physical camera, runtime data, credential values, cloud sessions or real API mutation.',
  limitation: 'Verifies settings UI, request payloads, fixture persistence, runtime delivery and synthetic motion. Does not measure physical-camera accuracy or backend storage persistence.',
  checks: [], configure: [], gestures: [], api: [], unexpectedApi: [], blockedExternal: [], blockedWebSockets: [], missingStatic: [], consoleErrors: [], pageErrors: [], runtime: [], screenshots: [] };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp4': 'video/mp4' };
const workerFixture = `
let motion='none', startedAt=null, sequence=0;
const palm=[[0,0],[-.04,-.05],[-.09,-.09],[-.12,-.14],[-.16,-.17],[-.06,-.17],[-.065,-.29],[-.07,-.37],[-.075,-.44],[0,-.19],[0,-.32],[0,-.41],[0,-.49],[.06,-.17],[.065,-.29],[.07,-.37],[.075,-.44],[.115,-.13],[.13,-.23],[.14,-.3],[.15,-.36]];
function hand(time){ const angle=motion==='wave'?Math.sin(time/1000*Math.PI*4)*Math.PI/5:0;return {handedness:'Left',landmarks:palm.map(([x,y])=>({x:.42+(x*Math.cos(angle)-y*Math.sin(angle))*.5,y:.56+(x*Math.sin(angle)+y*Math.cos(angle))*.5}))}; }
self.onmessage=({data})=>{
 if(data.type==='init')return self.postMessage({type:'ready'});
 if(data.type==='close')return self.close();
 if(data.type==='test-motion'){motion=data.motion;startedAt=null;sequence=data.sequence;return;}
 if(data.type!=='detect')return;
 startedAt??=data.timestamp;data.bitmap.close();
 self.postMessage({type:'result',frameId:data.frameId,timestamp:data.timestamp,poses:[],hands:motion==='none'?[]:[hand(data.timestamp-startedAt)],inferenceMs:5,testSequence:sequence,testMotion:motion});
};`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1512, height: 1200 }, permissions: ['camera'] });
await context.routeWebSocket(/.*/, websocket => { report.blockedWebSockets.push(websocket.url()); websocket.close(); });
await context.route('**/*', async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (![controlOrigin, cameraOrigin].includes(url.origin)) { report.blockedExternal.push(url.href); return route.abort(); }
  const endpoint = url.pathname.replace(/^\/v1\.1(?=\/)/, '');
  if (endpoint.startsWith('/api/')) {
    report.api.push({ method: request.method(), path: endpoint });
    let response;
    if (endpoint === '/api/exhibition/native-identity') response = { native: false };
    else if (endpoint === '/api/exhibition/mirrors') response = { defaultMirrorId: 'default', mirrors: [{ id: 'default', name: '识别设置测试镜', phase: state.phase, revision: state.revision, providerMode: 'xmax', updatedAt: state.updatedAt, binding: null }] };
    else if (endpoint === '/api/exhibition/mirrors/default') response = state;
    else if (endpoint === '/api/exhibition/mirrors/default/live/status') response = { configured: false, mode: 'xmax', model: 'x2.0', providerRegion: 'global', perSessionLimit: 100, expireSeconds: 300, heartbeatTimeoutSeconds: 30, live: null };
    else if (endpoint === '/api/exhibition/mirrors/default/credentials' && request.method() === 'GET') response = { configured: false, editable: true, source: 'mirror', revision: 0, perSessionLimit: 100, region: 'global', hasUnconfirmedSession: false };
    else if (endpoint === '/api/exhibition/mirrors/default/command' && request.method() === 'POST') {
      const input = request.postDataJSON();
      assert.equal(input.expectedRevision, state.revision, 'UI commands carry current revision');
      if (input.action === 'configure') {
        assert.deepEqual(Object.keys(input).sort(), ['action', 'expectedRevision', 'gestureRecognition']);
        report.configure.push(structuredClone(input));
        state.settings.gestureRecognition = structuredClone(input.gestureRecognition);
      } else {
        assert.equal(input.action, 'select', 'No generation command is permitted in this test');
        assert.ok(state.enabledLookIds.includes(input.lookId));
        report.gestures.push(structuredClone(input)); state.selectedLookId = input.lookId; state.phase = 'select';
      }
      state.revision++; state.updatedAt = Date.now(); response = state;
    } else {
      report.unexpectedApi.push({ method: request.method(), path: endpoint });
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Fixture blocks this endpoint' }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(response), headers: { 'Cache-Control': 'no-store' } });
  }
  if (endpoint.endsWith('/assets/exhibition-gestures/pose-landmarker.worker.js')) return route.fulfill({ contentType: 'text/javascript', body: workerFixture });
  if (endpoint === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
  const filename = ['/exhibition/control', '/exhibition/screen'].includes(endpoint) ? path.join(dist, 'index.html') : path.resolve(dist, `.${endpoint}`);
  if (!filename.startsWith(`${dist}${path.sep}`)) return route.abort();
  try { return route.fulfill({ contentType: types[path.extname(filename)] || 'application/octet-stream', body: await readFile(filename), headers: { 'Cache-Control': 'no-store' } }); }
  catch { report.missingStatic.push(endpoint); return route.fulfill({ status: 404, body: 'Fixture file missing' }); }
});
await context.addInitScript(() => {
  const trace = window.__gestureSettingsTest = { init: [], frames: [], results: 0, workers: [], ready: 0, closes: 0, getUserMediaCalls: 0, stopCalls: 0, sequence: 0 };
  const capture = navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
  if (capture) navigator.mediaDevices.getUserMedia = async (...args) => { trace.getUserMediaCalls++; return capture(...args); };
  const stop = MediaStreamTrack.prototype.stop;
  MediaStreamTrack.prototype.stop = function (...args) { trace.stopCalls++; return stop.apply(this, args); };
  const NativeWorker = window.Worker;
  window.Worker = new Proxy(NativeWorker, { construct(target, args) {
    const worker = Reflect.construct(target, args); const id = trace.workers.length;
    trace.workers.push(worker);
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (message, ...rest) => {
      if (message.type === 'init') trace.init.push({ id, ...structuredClone(message) });
      if (message.type === 'close') trace.closes++;
      if (message.type === 'detect') trace.frames.push({ id, timestamp: message.timestamp, width: message.bitmap.width, height: message.bitmap.height });
      return post(message, ...rest);
    };
    worker.addEventListener('message', event => {
      if (event.data.type === 'ready') trace.ready++;
      if (event.data.type === 'result') { trace.results++; trace.sequence = event.data.testSequence; trace.motion = event.data.testMotion; }
    });
    return worker;
  } });
});
function watch(page) {
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
}
const control = await context.newPage(); watch(control);
const screen = await context.newPage(); watch(screen);
const form = control.getByRole('form', { name: '手势识别设置' });
async function verifyForm(settings) {
  assert.equal(await form.getByRole('checkbox', { name: '手掌识别', exact: true }).isChecked(), settings.gestures.includes('open_palm'));
  assert.equal(await form.getByRole('checkbox', { name: '左右挥手', exact: true }).isChecked(), settings.gestures.includes('wave'));
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'gestures') continue;
    if (key === 'inputLongEdge') assert.equal(await form.getByRole('combobox', { name: '识别分辨率（长边）', exact: true, includeHidden: true }).getAttribute('data-value'), String(value));
    else assert.equal(await form.locator(`[name="${key}"]`).inputValue(), String(value), key);
  }
}
async function save(settings) {
  const before = report.configure.length;
  await form.getByRole('button', { name: '保存识别设置', exact: true }).click();
  await control.waitForFunction(() => document.querySelector('.ex-gesture-saved')?.textContent.includes('已保存'));
  assert.equal(report.configure.length, before + 1);
  assert.deepEqual(report.configure.at(-1).gestureRecognition, settings);
  assert.deepEqual(state.settings.gestureRecognition, settings);
  await verifyForm(settings);
}
async function screenSettings(gestures, active = true) {
  await screen.waitForFunction(({ value, active }) => {
    const element = document.querySelector('.ex-mirror-gesture');
    return element?.getAttribute('data-enabled-gestures') === value && element.getAttribute('data-status') === (active ? 'ready' : 'off')
      && (!active || element.getAttribute('data-capture') === 'active');
  }, { value: gestures.join(','), active }, { timeout: 15000 });
}
async function motion(value) {
  const count = await screen.evaluate(() => window.__gestureSettingsTest.results);
  await screen.waitForFunction(count => window.__gestureSettingsTest.results >= count + 3, count);
  const sequence = await screen.evaluate(value => {
    const trace = window.__gestureSettingsTest; const sequence = (trace.requestSequence || 0) + 1; trace.requestSequence = sequence;
    trace.workers.at(-1).postMessage({ type: 'test-motion', motion: value, sequence }); return sequence;
  }, value);
  await screen.waitForFunction(sequence => window.__gestureSettingsTest.sequence === sequence, sequence);
}
async function runtime(label, settings) {
  await screen.waitForFunction(() => { const trace = window.__gestureSettingsTest; return trace.frames.filter(frame => frame.id === trace.init.at(-1)?.id).length >= 12; });
  const data = await screen.evaluate(() => { const trace = window.__gestureSettingsTest; return { init: trace.init, frames: trace.frames.slice(-60), getUserMediaCalls: trace.getUserMediaCalls, stopCalls: trace.stopCalls, closes: trace.closes }; });
  const current = data.init.at(-1);
  assert.deepEqual(current.options, { minHandDetectionConfidence: settings.minHandDetectionConfidence, minHandPresenceConfidence: settings.minHandPresenceConfidence, minTrackingConfidence: settings.minTrackingConfidence });
  const frames = data.frames.filter(frame => frame.id === current.id).slice(-10);
  assert.ok(frames.length >= 10);
  for (const frame of frames) assert.equal(Math.max(frame.width, frame.height), settings.inputLongEdge);
  const gaps = frames.slice(1).map((frame, index) => frame.timestamp - frames[index].timestamp);
  // Scheduler uses wall-clock samples, so allow one millisecond clock rounding.
  assert.ok(gaps.every(gap => gap >= 1000 / settings.maxFps - 1), `capture exceeded FPS limit: ${gaps}`);
  assert.equal(data.getUserMediaCalls, 1, 'Changing recognition must reuse the camera'); assert.equal(data.stopCalls, 0);
  report.runtime.push({ label, ...data, gaps });
}
async function capture(filename, page = control) {
  const file = path.join(output, filename); await page.screenshot({ path: file, fullPage: true }); report.screenshots.push(file);
}
try {
  await control.goto(controlUrl, { waitUntil: 'domcontentloaded' }); await form.waitFor();
  await verifyForm(defaults); assert.equal(await form.getByRole('button', { name: '保存识别设置' }).isDisabled(), true);
  report.checks.push('Legacy missing settings render palm-only defaults');
  await screen.goto(screenUrl, { waitUntil: 'domcontentloaded' }); await screenSettings(['open_palm']); await runtime('legacy defaults', defaults);
  report.checks.push('Legacy default is delivered to mirror worker and capture');
  await form.locator('summary').click();
  await form.locator('[name="palmConfirmMs"]').fill('');
  assert.equal(await form.getByRole('button', { name: '保存识别设置' }).isDisabled(), true);
  await form.locator('[name="palmConfirmMs"]').fill('149');
  assert.equal(await form.getByRole('button', { name: '保存识别设置' }).isDisabled(), true);
  await form.getByRole('button', { name: '取消修改' }).click(); await verifyForm(defaults);
  report.checks.push('Empty/out-of-range draft cannot save and cancellation restores values');
  await form.getByRole('checkbox', { name: '左右挥手', exact: true }).check();
  for (const [key, value] of Object.entries(tuned)) {
    if (key === 'gestures') continue;
    if (key === 'inputLongEdge') {
      await form.getByRole('combobox', { name: '识别分辨率（长边）', exact: true }).click();
      await form.getByRole('option', { name: `${value} px`, exact: true }).click();
    } else await form.locator(`[name="${key}"]`).fill(String(value));
  }
  await save(tuned); report.checks.push('Multi-select and all seven parameters submit atomically with expectedRevision');
  await control.reload({ waitUntil: 'domcontentloaded' }); await form.waitFor(); await verifyForm(tuned);
  await form.locator('summary').click();
  await form.getByRole('button', { name: '恢复默认', exact: true }).scrollIntoViewIfNeeded();
  await capture('control-desktop-settings.png');
  await control.setViewportSize({ width: 390, height: 844 }); await capture('control-mobile-settings.png'); await control.setViewportSize({ width: 1512, height: 1200 });
  report.checks.push('Configured values survive page reload in shared fixture state');
  await screenSettings(tuned.gestures); await runtime('tuned settings', tuned);
  const startCommands = report.gestures.length;
  await motion('wave'); await screen.waitForTimeout(1700);
  assert.equal(report.gestures.length, startCommands + 1, 'One moving palm must share the confirmation latch across both gestures');
  await screen.waitForTimeout(1300); assert.equal(report.gestures.length, startCommands + 1, 'Continuous motion cannot repeatedly switch');
  report.checks.push('Multi-select shares action deduplication and continued motion does not repeat');
  await motion('none'); await screen.waitForTimeout(650);
  await form.getByRole('checkbox', { name: '手掌识别', exact: true }).uncheck();
  const waveOnly = { ...tuned, gestures: ['wave'] }; await save(waveOnly); await screenSettings(['wave']);
  const waveStart = report.gestures.length;
  await motion('open'); await screen.waitForTimeout(900); assert.equal(report.gestures.length, waveStart, 'Wave-only does not accept a stationary palm');
  await motion('wave'); await screen.waitForTimeout(1400); assert.equal(report.gestures.length, waveStart + 1, 'Wave-only accepts motion');
  report.checks.push('Wave-only suppresses stationary palm and accepts wave');
  await form.getByRole('checkbox', { name: '左右挥手', exact: true }).uncheck();
  await save({ ...tuned, gestures: [] }); await screenSettings([], false);
  assert.equal(await screen.locator('.ex-mirror-gesture').isDisabled(), true);
  const disabledStats = await screen.evaluate(() => ({ results: window.__gestureSettingsTest.results, calls: window.__gestureSettingsTest.getUserMediaCalls, stops: window.__gestureSettingsTest.stopCalls }));
  await screen.waitForTimeout(450);
  assert.equal(await screen.evaluate(() => window.__gestureSettingsTest.results), disabledStats.results);
  assert.deepEqual({ calls: disabledStats.calls, stops: disabledStats.stops }, { calls: 1, stops: 0 });
  report.checks.push('Empty selection stops recognition while keeping the same local camera');
  await form.getByRole('button', { name: '恢复默认', exact: true }).click(); await verifyForm(defaults);
  assert.deepEqual(state.settings.gestureRecognition.gestures, [], 'Restore defaults is a draft until saved');
  await save(defaults); await screenSettings(['open_palm']); await runtime('restored defaults', defaults);
  const restoredStart = report.gestures.length;
  await motion('none'); await screen.waitForTimeout(700); await motion('open'); await screen.waitForTimeout(1000);
  assert.equal(report.gestures.length, restoredStart + 1, 'Restored palm-only setting accepts natural palm');
  await screen.waitForTimeout(800); assert.equal(report.gestures.length, restoredStart + 1);
  await capture('screen-restored-defaults.png', screen);
  report.checks.push('Saved restore defaults restarts worker using default parameters and palm-only recognition');
  assert.equal(report.pageErrors.length, 0); assert.equal(report.unexpectedApi.length, 0); assert.equal(report.missingStatic.length, 0);
  assert.equal(report.api.some(item => item.path.includes('/live/session')), false);
  assert.equal(report.blockedWebSockets.length, 0);
  assert.ok(report.api.filter(item => item.method !== 'GET').every(item => item.path === '/api/exhibition/mirrors/default/command'));
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack;
  try { await capture('failure-control.png'); await capture('failure-screen.png', screen); } catch {}
  throw error;
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify({ status: report.status, checks: report.checks, configured: report.configure.length, gestureCommands: report.gestures.length, output }, null, 2));
}
