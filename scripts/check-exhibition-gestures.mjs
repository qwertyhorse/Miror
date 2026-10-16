import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

const output = path.resolve(process.env.GESTURE_CHECK_OUTPUT || 'artifacts/mirror-gesture-browser-check');
const dist = process.env.GESTURE_CHECK_DIST || path.resolve('artifacts/mirror-gesture-recheck-20261013/staging/dist');
const origin = 'https://xuminghong.local:10202';
const screen = `${origin}/v1.1/exhibition/screen?mirror=default`;
await mkdir(output, { recursive: true });
const entryAssets = [...(await readFile(path.join(dist, 'index.html'), 'utf8')).matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1]);
const report = {
  target: screen, dist, entryAssets, checkedAt: new Date().toISOString(),
  camera: 'Chrome fake media device; no physical camera',
  isolation: 'All static files are fulfilled from the specified local dist. All API calls are fixture responses. External requests and all WebSockets are blocked. No runtime data, credentials or XMAX sessions are read or changed.',
  limitation: 'Verifies frontend integration with real local MediaPipe startup and synthetic landmarks; does not measure recognition accuracy on a physical camera.',
  scenarios: [],
};
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

function fixtureState(phase = 'idle') {
  return {
    mirrorId: 'default', revision: 1, phase, experienceMode: 'clothx',
    selectedLookId: 'commute', displayedLookId: null, enabledLookIds: ['commute', 'city', 'evening'],
    looks: [
      { id: 'commute', name: '轻盈通勤', image: '/assets/exhibition/commute-cutout.png', mode: 'clothx' },
      { id: 'city', name: '都市休闲', image: '/assets/exhibition/city-cutout.png', mode: 'clothx' },
      { id: 'evening', name: '优雅礼服', image: '/assets/exhibition/evening-cutout.png', mode: 'clothx' },
    ].map(look => ({ ...look, description: '', source: 'sample', palette: '', category: '', tags: [] })),
    categories: [], tags: [], sessionNumber: 1, generationNumber: 1, updatedAt: Date.now(), generationReadyAt: null,
    providerMode: 'xmax', live: null, logs: [],
    settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 },
      gestureRecognition: { gestures: ['open_palm', 'wave'], minHandDetectionConfidence: 0.35, minHandPresenceConfidence: 0.35, minTrackingConfidence: 0.5, palmConfirmMs: 300, palmReleaseMs: 500, maxFps: 15, inputLongEdge: 720 } },
  };
}

const syntheticWorker = `
let motion='closed', startedAt=null, sequence=0, frame=0;
const closeCamera=UPPER_BODY_FIXTURE;
const handsOnly=HAND_ONLY_FIXTURE;
const sourceFlap=SOURCE_FLAP_FIXTURE;
const naturalPalm=NATURAL_PALM_FIXTURE;
const palm=[[0,0],[-.04,-.05],[-.09,-.09],[-.12,-.14],[-.16,-.17],[-.06,-.17],[-.065,-.29],[-.07,-.37],[-.075,-.44],[0,-.19],[0,-.32],[0,-.41],[0,-.49],[.06,-.17],[.065,-.29],[.07,-.37],[.075,-.44],[.115,-.13],[.13,-.23],[.14,-.3],[.15,-.36]];
function hand(elapsed) {
 const points=palm.map(([x,y])=>({x,y}));
 if(naturalPalm)for(const i of [18,19,20]){points[i]={x:points[17].x+(points[i].x-points[17].x)*.5,y:points[17].y+(points[i].y-points[17].y)*.5};}
 if(motion==='closed')for(const i of [5,9,13,17]){points[i+2]={x:points[i].x+.02,y:points[i].y-.07};points[i+3]={x:points[i].x+.02,y:points[i].y+.03};}
 const angle=motion==='wave'?Math.sin(elapsed/1000*Math.PI*4)*Math.PI/5:0;
 return {handedness:'Left',landmarks:points.map(p=>({x:.30+(p.x*Math.cos(angle)-p.y*Math.sin(angle))*.5,y:(closeCamera?.61:.42)+(p.x*Math.sin(angle)+p.y*Math.cos(angle))*.5}))};
}
function pose(center=.5) {
 const points=Array.from({length:33},()=>({x:center,y:.5,z:0,visibility:.99,presence:.99}));
 function set(i,x,y){points[i]={x:x+center-.5,y,z:0,visibility:.99,presence:.99};}
 set(0,.5,closeCamera?.70:.36);set(2,.46,closeCamera?.68:.34);set(5,.54,closeCamera?.68:.34);
 set(11,.35,closeCamera?.84:.55);set(12,.65,closeCamera?.84:.55);
 set(13,.30,closeCamera?.85:.61);set(14,.70,closeCamera?.85:.61);
 set(15,.30,closeCamera?.61:.42);set(16,.70,closeCamera?.97:.80);
 set(23,.38,closeCamera?1.12:.85);set(24,.62,closeCamera?1.12:.85);
 return {landmarks:points};
}
self.onmessage=({data})=>{
 if(data.type==='init')return self.postMessage({type:'ready'});
 if(data.type==='close')return self.close();
 if(data.type==='test-motion'){motion=data.motion;startedAt=null;sequence=data.sequence;return;}
 if(data.type!=='detect')return;
 startedAt??=data.timestamp;
 const poses=motion==='ambiguous'?[pose(.4),pose(.65)]:handsOnly?[]:[pose()];
 if(sourceFlap && motion==='open' && poses.length===1) poses[0].landmarks[15].visibility=(++frame % 2) ? .64 : .99;
 const hands=motion==='none'?[]:[hand(data.timestamp-startedAt)];
 if(motion==='two-hands')hands.push({...hands[0],landmarks:hands[0].landmarks.map(p=>({...p,x:p.x+.4}))});
 data.bitmap.close();
 self.postMessage({type:'result',frameId:data.frameId,timestamp:data.timestamp,poses,hands,inferenceMs:35,testMotion:motion,testSequence:sequence});
};`;

const contentTypes = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp4': 'video/mp4',
};

async function scenario(synthetic = false, phase = 'idle', upperBody = false, handOnly = false, sourceFlap = false, naturalPalm = false) {
  const state = fixtureState(phase);
  const name = naturalPalm ? 'synthetic-natural-palm-short-pinky' : sourceFlap ? 'synthetic-body-hand-handover' : handOnly ? 'synthetic-hand-only-palm-wave' : upperBody ? 'synthetic-upper-body-palm-wave' : synthetic ? phase === 'showcase' ? 'synthetic-palm-wave-showcase-switch' : 'synthetic-palm-wave-selection' : 'real-local-pose-and-hands-worker';
  const item = {
    name, synthetic, initialPhase: phase,
    fixtureNote: phase === 'showcase' ? 'Fixture retains showcase and live=null after switch; no XMAX allocation or restart occurs.' : '',
    api: [], commands: [], blockedExternal: [], blockedWebSockets: [], requests: [], staticFiles: [],
    consoleErrors: [], pageErrors: [], snapshots: [],
  };
  report.scenarios.push(item);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 900, height: 1440 }, permissions: ['camera'] });
  await context.routeWebSocket(/.*/, websocket => { item.blockedWebSockets.push(websocket.url()); websocket.close(); });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    item.requests.push({ method: request.method(), url: url.href });
    if (url.origin !== origin) { item.blockedExternal.push(url.href); return route.abort(); }
    const endpoint = url.pathname.replace(/^\/v1\.1(?=\/)/, '');
    if (endpoint.startsWith('/api/')) {
      item.api.push({ method: request.method(), path: endpoint });
      let response;
      if (endpoint === '/api/exhibition/native-identity') response = { native: false };
      else if (endpoint === '/api/exhibition/mirrors') response = { defaultMirrorId: 'default', mirrors: [{ id: 'default', name: '浏览器验收镜端', phase: state.phase, revision: state.revision, providerMode: 'xmax', updatedAt: state.updatedAt, binding: null }] };
      else if (endpoint === '/api/exhibition/mirrors/default') response = state;
      else if (endpoint === '/api/exhibition/mirrors/default/live/status') response = { configured: true, mode: 'xmax', model: 'x2.0', providerRegion: 'global', perSessionLimit: 100, expireSeconds: 300, heartbeatTimeoutSeconds: 30, live: null };
      else if (endpoint === '/api/exhibition/mirrors/default/command' && request.method() === 'POST') {
        const input = request.postDataJSON();
        item.commands.push(input);
        assert.equal(input.action, phase === 'showcase' ? 'switch' : 'select');
        assert.equal(input.expectedRevision, state.revision);
        assert.ok(state.enabledLookIds.includes(input.lookId));
        state.selectedLookId = input.lookId;
        if (phase === 'showcase') state.generationNumber += 1;
        state.phase = phase === 'showcase' ? 'showcase' : 'select';
        state.revision += 1;
        state.updatedAt = Date.now();
        response = state;
      } else {
        item.unexpectedApi ??= [];
        item.unexpectedApi.push({ method: request.method(), path: endpoint });
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Browser fixture blocks this endpoint.' }) });
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(response), headers: { 'Cache-Control': 'no-store' } });
    }
    if (synthetic && endpoint.endsWith('/assets/exhibition-gestures/pose-landmarker.worker.js')) {
      return route.fulfill({ contentType: 'text/javascript', body: syntheticWorker.replace('UPPER_BODY_FIXTURE', String(upperBody)).replace('HAND_ONLY_FIXTURE', String(handOnly)).replace('SOURCE_FLAP_FIXTURE', String(sourceFlap)).replace('NATURAL_PALM_FIXTURE', String(naturalPalm)) });
    }
    if (endpoint === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
    const filename = endpoint === '/exhibition/screen' ? path.join(dist, 'index.html') : path.resolve(dist, `.${endpoint}`);
    if (!filename.startsWith(`${dist}${path.sep}`)) return route.abort();
    try {
      const body = await readFile(filename);
      item.staticFiles.push({ path: endpoint, file: filename, bytes: body.length });
      return route.fulfill({ contentType: contentTypes[path.extname(filename)] ?? 'application/octet-stream', body, headers: { 'Cache-Control': 'no-store' } });
    } catch {
      item.missingStatic ??= [];
      item.missingStatic.push(endpoint);
      return route.fulfill({ status: 404, body: 'Fixture file missing' });
    }
  });
  await context.addInitScript(() => {
    window.__frameTrace = [];
    const stats = window.__waveCheck = { getUserMediaCalls: 0, stopCalls: 0, workerReady: 0, workerResults: 0, workerHandFrames: 0, workerUrls: [], testMotion: null, testSequence: 0 };
    window.__waveStreams = [];
    window.__waveWorkers = [];
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      stats.getUserMediaCalls += 1;
      const stream = await capture(...args);
      window.__waveStreams.push(stream);
      return stream;
    };
    const stop = MediaStreamTrack.prototype.stop;
    MediaStreamTrack.prototype.stop = function (...args) { stats.stopCalls += 1; return stop.apply(this, args); };
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, { construct(target, args) {
      const worker = Reflect.construct(target, args);
      stats.workerUrls.push(String(args[0]));
      window.__waveWorkers.push(worker);
      worker.addEventListener('message', event => {
        if (event.data.type === 'ready') stats.workerReady += 1;
        if (event.data.type === 'result') { stats.workerResults += 1; window.__frameTrace.push({timestamp:event.data.timestamp, y:event.data.poses?.[0]?.landmarks?.[15]?.y, motion:event.data.testMotion, raised:document.querySelector('.ex-mirror-gesture')?.getAttribute('data-hand-raised')}); }
        if (event.data.type === 'result' && event.data.poses?.length) stats.workerHandFrames += 1;
        if (event.data.type === 'result' && event.data.testMotion) {
          stats.testMotion = event.data.testMotion;
          stats.testSequence = event.data.testSequence;
        }
      });
      return worker;
    } });
  });
  const page = await context.newPage();
  page.on('console', message => { if (message.type() === 'error') item.consoleErrors.push(message.text()); });
  page.on('pageerror', error => item.pageErrors.push(error.message));
  const gesture = page.locator('.ex-mirror-gesture');
  async function snapshot(label) {
    const value = await page.evaluate(() => {
      const video = document.querySelector('video[aria-label="本地取景"]');
      const gesture = document.querySelector('.ex-mirror-gesture');
      return { ...window.__waveCheck, frameTrace: window.__frameTrace, secure: window.isSecureContext,
        gestureStatus: gesture?.getAttribute('data-status'), gestureLabel: gesture?.innerText,
        detection: gesture?.getAttribute('data-detection'), captureStatus: gesture?.getAttribute('data-capture'),
        handDetected: gesture?.getAttribute('data-hand-detected'), handRaised: gesture?.getAttribute('data-hand-raised'), operator: gesture?.getAttribute('data-operator'), armed: gesture?.getAttribute('data-armed'),
        inferenceFps: Number(gesture?.getAttribute('data-inference-fps')),
        indicatorColor: gesture?.querySelector('i') ? getComputedStyle(gesture.querySelector('i')).backgroundColor : null,
        decoderAttached: !!document.querySelector('video[aria-hidden="true"]'),
        localVideo: video ? { readyState: video.readyState, width: video.videoWidth, height: video.videoHeight, paused: video.paused,
          reusesCapture: video.srcObject === window.__waveStreams[0], trackStates: video.srcObject?.getVideoTracks().map(track => track.readyState) } : null,
      };
    });
    item.snapshots.push({ label, ...value });
    return value;
  }
  function assertCapture(value) {
    assert.equal(value.getUserMediaCalls, 1);
    assert.equal(value.stopCalls, 0);
    assert.equal(value.localVideo.reusesCapture, true);
    assert.deepEqual(value.localVideo.trackStates, ['live']);
  }
  async function setMotion(motion) {
    // Screenshots can pause headless video decoding; start each injected motion only after capture resumes.
    const frameCount = await page.evaluate(() => window.__waveCheck.workerResults);
    await page.waitForFunction(count => window.__waveCheck.workerResults >= count + 4, frameCount);
    const sequence = await page.evaluate(value => {
      const sequence = (window.__testMotionSequence ?? 0) + 1;
      window.__testMotionSequence = sequence;
      window.__waveWorkers.at(-1).postMessage({ type: 'test-motion', motion: value, sequence });
      return sequence;
    }, motion);
    await page.waitForFunction(value => window.__waveCheck.testSequence === value, sequence);
  }
  try {
    await page.goto(synthetic ? screen + '&diagnostics=1' : screen, { waitUntil: 'domcontentloaded' });
    await gesture.waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector('.ex-mirror-gesture')?.getAttribute('data-status') === 'ready', null, { timeout: 45_000 });
    await page.waitForFunction(() => { const video = document.querySelector('video[aria-label="本地取景"]'); return video?.readyState >= 2 && video.videoWidth > 0; });
    await page.waitForFunction(() => document.querySelector('.ex-mirror-gesture')?.getAttribute('data-capture') === 'active');
    if (synthetic && !handOnly) await page.waitForFunction(() => document.querySelector('.ex-mirror-gesture')?.getAttribute('data-armed') === 'true');
    const ready = await snapshot('ready');
    assertCapture(ready);
    assert.equal(ready.decoderAttached, true);
    assert.equal(item.commands.length, 0);
    await page.waitForFunction(() => document.querySelector('link[rel=preconnect]')?.href === 'https://api.xmax.ai/');
    item.sdkPreloaded = true; item.apiPreconnectHint = 'https://api.xmax.ai';
    assert.equal(item.api.some(request => request.path.endsWith('/live/session')), false, 'entry does not allocate a cloud session');
    if (!synthetic) {
      assert.equal(await page.getByRole('complementary', { name: '智能镜诊断' }).count(), 0);
      await page.waitForFunction(() => window.__waveCheck.workerResults >= 4);
      const processing = await snapshot('real-pose-no-participant');
      assert.equal(processing.handDetected, 'false');
      assert.equal(processing.operator, 'searching');
      assert.match(processing.gestureLabel, /请露出手掌/);
      assert.ok(processing.inferenceFps > 0 && processing.inferenceFps <= 15);
      for (const asset of ['vision_bundle.js', 'pose_landmarker_full.task', 'hand_landmarker.task', 'vision_wasm_internal.js', 'vision_wasm_internal.wasm']) {
        assert.ok(item.requests.some(request => request.url.endsWith('/' + asset)), 'Missing local asset ' + asset);
      }
      await page.evaluate(() => { window.__waveStreams[0].getVideoTracks()[0].enabled = false; });
      await page.waitForFunction(() => document.querySelector('.ex-mirror-gesture')?.getAttribute('data-capture') === 'disabled');
      assert.match((await snapshot('camera-paused')).gestureLabel, /取景已暂停/);
      await page.evaluate(() => { window.__waveStreams[0].getVideoTracks()[0].enabled = true; });
      await page.waitForFunction(() => document.querySelector('.ex-mirror-gesture')?.getAttribute('data-capture') === 'active');
      await gesture.click();
      await page.waitForFunction(() => document.querySelector('.ex-mirror-gesture')?.getAttribute('data-status') === 'off');
      const off = await snapshot('recognition-off'); assertCapture(off); assert.equal(off.decoderAttached, false);
      await gesture.click();
      await page.waitForFunction(() => document.querySelector('.ex-mirror-gesture')?.getAttribute('data-status') === 'ready', null, {timeout:45000});
      assertCapture(await snapshot('recognition-restarted'));
      assert.equal(item.commands.length, 0);
    } else {
      await page.getByRole('complementary', { name: '智能镜诊断' }).waitFor();
      assert.equal(await page.getByRole('button', { name: '已看到新衣服' }).isDisabled(), true);
      if(!handOnly){assert.equal(ready.operator,'locked');assert.equal(ready.armed,'true');assert.match(ready.gestureLabel,/挥手或展掌换装/);}
      await setMotion(handOnly ? 'two-hands' : 'open');
      await page.waitForTimeout(1500);
      assert.equal(item.commands.length,1,'presenting an already-raised open palm selects one material');
      assert.equal(item.commands[0].lookId,'city');
      await page.waitForTimeout(2200);
      assert.equal(item.commands.length,1,'held palm never repeats across command boundaries');
      assertCapture(await snapshot('held-palm-no-repeat'));
      if(handOnly){
        assert.equal(await gesture.getAttribute('data-control-source'),'hand');
        await setMotion('two-hands');
        await page.waitForFunction(()=>document.querySelector('.ex-mirror-gesture')?.getAttribute('data-operator')==='locked');
        assert.doesNotMatch((await snapshot('two-hands-accepted')).gestureLabel,/请只露一只手/);
        await setMotion('open');await page.waitForTimeout(1400);
        assert.equal(item.commands.length,1,'removing one of two consumed palms does not create a new presentation');
      }
      await setMotion('ambiguous');
      await page.waitForFunction(() => document.querySelector('.ex-mirror-gesture')?.getAttribute('data-operator') === 'locked');
      assert.doesNotMatch((await snapshot('multiple-people')).gestureLabel,/请单人体验/);
      assert.equal(item.commands.length,1);
      await setMotion('open');
      await page.waitForTimeout(1400);
      assert.equal(item.commands.length,1,'reacquiring the same displayed palm must not repeat');
      await setMotion('none'); await page.waitForTimeout(900);
      await setMotion('open'); await page.waitForTimeout(1500);
      assert.equal(item.commands.length,2,'withdrawal allows a second palm presentation');
      assert.equal(item.commands[1].lookId,'evening');
      await setMotion('wave'); await page.waitForTimeout(2500);
      assert.equal(item.commands.length,3,'fixed-wrist left-right palm wave switches once');
      assert.equal(item.commands[2].lookId,'commute');
      await page.waitForTimeout(2000);
      assert.equal(item.commands.length,3,'continued wave does not repeat');
      assert.deepEqual(item.commands.map(command=>command.action),Array(3).fill(phase==='showcase'?'switch':'select'));
      assert.equal(item.commands.some(command=>command.action==='begin'),false);
      assertCapture(await snapshot('palm-and-wave-confirmed'));
      await page.screenshot({ path: path.join(output, name + '-diagnostics.png'), fullPage: true });
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: '导出 JSON' }).click();
      const download = await downloadPromise;
      const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
      await writeFile(path.join(output, name + '-export.json'), JSON.stringify(exported, null, 2));
      const confirmed = exported.events.filter(event => event.type === 'gesture_confirmed');
      assert.ok(exported.events.some(event => event.type === 'sample' && event.metrics?.confirmationState === 'holding'));
      assert.ok(exported.events.some(event => event.type === 'sample' && event.metrics?.rawHandCount === 1));
      assert.equal(confirmed.length, 3);
      assert.deepEqual(confirmed.map(event=>event.metrics.gesture),['open_palm','open_palm','wave']);
      assert.equal(exported.stats.confirmed, 0);
      assert.equal(exported.events.filter(event => event.type === 'command_accepted').length, 3);
      for (const event of confirmed) {
        assert.equal('raiseLatencyMs' in event.metrics,false);
        const command = exported.events.find(candidate => candidate.type === 'command_sent' && candidate.actionId === event.actionId);
        assert.equal(command.interactionId, event.interactionId);
        assert.equal(command.context.mirrorId, event.context.mirrorId);
        assert.equal(command.context.sessionNumber, event.context.sessionNumber);
        assert.equal(command.context.generationNumber, event.context.generationNumber + (phase === 'showcase' ? 1 : 0));
      }
      assert.equal(exported.events.some(event => ['manual_visible', 'sdk_set_resolved'].includes(event.type)), false);
      assert.equal(exported.events.some(event => 'landmarks' in event || 'image' in event || 'token' in event || 'url' in event), false);
      await page.getByRole('button', { name: '清空记录' }).click();
      assert.equal(await page.getByLabel('最近诊断事件').locator('li').count(), 0);
      assert.equal(await page.getByRole('button', { name: '已看到新衣服' }).isDisabled(), true);
      const beforeClose = await page.evaluate(() => ({ cameras: window.__waveCheck.getUserMediaCalls, workers: window.__waveWorkers.length, stops: window.__waveCheck.stopCalls }));
      await page.getByRole('button', { name: '收起诊断' }).click();
      assert.equal(await page.getByLabel('最近诊断事件').count(), 0);
      await page.getByRole('button', { name: '展开诊断' }).click();
      await page.getByRole('button', { name: '关闭诊断' }).click();
      assert.equal(await page.getByRole('complementary', { name: '智能镜诊断' }).count(), 0);
      assert.equal(new URL(page.url()).searchParams.has('diagnostics'), false);
      await setMotion('none'); await page.waitForTimeout(900); await setMotion('open'); await page.waitForTimeout(1500);
      assert.equal(item.commands.length, 4, 'gesture command remains functional after closing diagnostics');
      const afterClose = await page.evaluate(() => ({ cameras: window.__waveCheck.getUserMediaCalls, workers: window.__waveWorkers.length, stops: window.__waveCheck.stopCalls }));
      assert.deepEqual(afterClose, beforeClose, 'closing diagnostic panel does not restart camera or worker');
      item.diagnostics = { exportedEvents: exported.events.length, gestures: confirmed.length, falseVisualSuccesses: exported.stats.confirmed, clearPassed: true, closePassed: true };

    }
    await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});
    assert.deepEqual(item.blockedExternal, []);
    assert.deepEqual(item.blockedWebSockets, []);
    assert.deepEqual(item.pageErrors, []);
    assert.equal(item.unexpectedApi?.length ?? 0, 0);
    assert.equal(item.missingStatic?.length ?? 0, 0);
    assert.ok(item.staticFiles.some(file => file.path === '/exhibition/screen'));
    item.passed = true;
  } catch (error) {
    item.passed = false;
    item.error = error.stack;
    item.body = await page.locator('body').innerText();
    await snapshot('failure');
    await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true });
    throw error;
  } finally {
    await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    await context.close();
  }
}

try {
  if (process.env.ONLY_NATURAL_PALM === '1') {
    await scenario(true, 'idle', false, false, false, true);
  } else {
    if (process.env.ONLY_UPPER === '1') {
      const previous = JSON.parse(await readFile(path.join(output, 'results.json'), 'utf8'));
      assert.deepEqual(previous.entryAssets, entryAssets);
      report.scenarios = previous.scenarios.filter(item => item.passed && item.name !== 'synthetic-upper-body-palm-wave');
    } else if (process.env.ONLY_HAND_GESTURES !== '1') {
      await scenario(false);
      await scenario(true);
      await scenario(true, 'showcase');
    }
    if (process.env.ONLY_HAND_GESTURES !== '1') await scenario(true, 'idle', true);
    await scenario(true, 'idle', false, true);
    await scenario(true, 'idle', false, false, true);
    await scenario(true, 'idle', false, false, false, true);
  }
  console.log(JSON.stringify(report.scenarios.map(item => ({ name: item.name, passed: item.passed, commands: item.commands, snapshots: item.snapshots.length, blockedExternal: item.blockedExternal, pageErrors: item.pageErrors })), null, 2));
} finally { await browser.close(); }
