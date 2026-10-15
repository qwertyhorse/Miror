import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import { createGestureInference } from '../server/gestureInference.ts';
import { createApiServer } from '../server/http.ts';
import { RemoteGestureCoordinator } from '../server/remoteGestures.ts';
import { TryOnService } from '../server/service.ts';
import { SecretBox, SessionStore } from '../server/store.ts';
import { resolveExhibitionGestureSettings } from '../shared/exhibitionGestures.ts';

// Real HTTP, MediaPipe and detector; only public sample pixels and a temporary private registry.
// No production settings are read. Every supplier operation throws before doing any networking.
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const sourceUrl = 'https://storage.googleapis.com/mediapipe-tasks/hand_landmarker/woman_hands.jpg';
const source = option('--sample') ? await readFile(option('--sample'))
  : Buffer.from(await (await fetch(sourceUrl, { signal: AbortSignal.timeout(20_000) })).arrayBuffer());
assert(source.length < 8 * 1024 * 1024);
const sourceHash = createHash('sha256').update(source).digest('hex');
assert.equal(sourceHash, '70cbeb38e198c9862202e0979c21a99b40ca980d3e7b250176c85b1636a40f12', 'Use the documented official sample for this fixed crop');
const scaled = await sharp(source).resize({ width: 640, height: 640, fit: 'inside' }).jpeg().toBuffer();
const cropBounds = { left: 0, top: 394, width: 186, height: 126 };
const palm = await sharp(scaled).extract(cropBounds).resize({ width: 480, height: 640, fit: 'contain', background: '#fff' }).jpeg().toBuffer();
const blank = await sharp({ create: { width: 480, height: 640, channels: 3, background: '#fff' } }).jpeg().toBuffer();
const movingPalm = await Promise.all([0, 30, 60, 30, 0].map(async offset => sharp(palm)
  .extract({ left: offset, top: 0, width: 480 - offset, height: 640 })
  .extend({ left: 0, right: offset, top: 0, bottom: 0, background: '#fff' }).jpeg().toBuffer()));
const percentiles = values => {
  const sorted = values.slice().sort((a, b) => a - b);
  return { p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))],
    max: sorted.at(-1), mean: values.reduce((a, b) => a + b, 0) / values.length };
};
const directory = await mkdtemp(path.join(tmpdir(), 'miror-real-gesture-http-'));
const store = new SessionStore(':memory:');
const supplierCalls = [];
const denySupplier = async () => { supplierCalls.push('blocked'); throw new Error('Supplier calls are forbidden in this fixture'); };
const provider = { configured: true, issueKey: denySupplier, deactivate: denySupplier, keyStatus: denySupplier, sessionStatus: denySupplier };
const service = new TryOnService({ provider, store, secrets: new SecretBox(randomBytes(32)), catalog: async () => [],
  resolveHost: async () => { throw new Error('External reference DNS is forbidden in this fixture'); } });
const mirrors = new ExhibitionMirrors(directory);
const coordinator = new RemoteGestureCoordinator({ createInference: createGestureInference });
const origin = 'http://xuxin.local:10101';
const server = createApiServer(service, [origin], undefined, mirrors, coordinator);
const requestCounts = {};
server.on('request', request => {
  const route = request.url.replace(/\/mirrors\/[^/]+/, '/mirrors/:id');
  requestCounts[route] = (requestCounts[route] ?? 0) + 1;
});
let base;
async function jsonRequest(route, value) {
  const response = await fetch(base + route, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Miror-Protocol': '2' },
    body: JSON.stringify(value), signal: AbortSignal.timeout(20_000) });
  const result = await response.json();
  assert(response.ok, `${route}: HTTP ${response.status} ${JSON.stringify(result)}`);
  return result;
}
const streams = [];
const trace = [];
async function control(stream, blocked, reset = false) {
  stream.blocked = blocked;
  stream.epoch++;
  return jsonRequest(`${stream.root}/gestures/control`, { ...stream.auth, sessionId: stream.sessionId, epoch: stream.epoch, blocked, reset });
}
async function frame(stream, pixels, stage, expectedEvent = null) {
  stream.timestamp += 110;
  const started = performance.now();
  const response = await fetch(`${base}${stream.root}/gestures/frame`, { method: 'POST', headers: {
    Origin: origin, 'Content-Type': 'image/jpeg',
    'x-openbuy-terminal-id': stream.auth.terminalId, 'x-openbuy-terminal-token': stream.auth.terminalToken,
    'x-openbuy-gesture-session': stream.sessionId, 'x-openbuy-gesture-epoch': String(stream.epoch),
    'x-openbuy-gesture-seq': String(++stream.seq), 'x-openbuy-gesture-time': String(stream.timestamp),
    'x-openbuy-gesture-blocked': String(stream.blocked),
  }, body: pixels, signal: AbortSignal.timeout(10_000) });
  const snapshot = await response.json();
  assert(response.ok, `${stage}/${stream.label}: HTTP ${response.status} ${JSON.stringify(snapshot)}`);
  const elapsed = performance.now() - started;
  stream.httpMs.push(elapsed); stream.inferenceMs.push(snapshot.inferenceMs);
  assert.equal(snapshot.sessionId, stream.sessionId);
  assert.equal(snapshot.seq, stream.seq);
  assert.equal(snapshot.epoch, stream.epoch);
  assert(snapshot.rawHandCount <= 1, 'Public crop must represent one hand only');
  if (expectedEvent !== 'allow') assert.equal(snapshot.event, expectedEvent, `${stage}/${stream.label}: unexpected event`);
  trace.push({ terminal: stream.label, stage, seq: stream.seq, timestamp: stream.timestamp, hands: snapshot.rawHandCount,
    event: snapshot.event, blocked: snapshot.blocked, needsRelease: snapshot.needsRelease,
    confirmation: snapshot.confirmationState, httpMs: elapsed, inferenceMs: snapshot.inferenceMs });
  if (snapshot.event) {
    assert.equal(snapshot.event, 'open_palm');
    const state = mirrors.getMirror(stream.mirrorId).read();
    const lookIds = state.publication.looks.filter(look => look.mode === state.experienceMode).map(look => look.id);
    const lookId = lookIds[(lookIds.indexOf(state.selectedLookId) + 1) % lookIds.length];
    const changed = await jsonRequest(`${stream.root}/command`, { action: 'select', lookId, commandId: randomUUID() });
    assert.equal(changed.selectedLookId, lookId);
    stream.commands++;
  }
  return snapshot;
}
async function pair(stage, pixelsA, pixelsB, count = 7, allow = [false, false]) {
  for (let i = 0; i < count; i++) await Promise.all(streams.map((stream, index) => frame(stream,
    (index === 0 ? pixelsA : pixelsB), stage, allow[index] ? 'allow' : null)));
}
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  const ids = ['default', mirrors.create({ name: 'Isolated second terminal' }).id];
  for (const [index, mirrorId] of ids.entries()) {
    const terminalId = `terminal-${randomUUID()}`, terminalToken = randomBytes(32).toString('hex');
    const connection = await jsonRequest('/api/exhibition/terminals/connect', { terminalId, token: terminalToken, label: `isolated-ML-${index + 1}`, platform: 'android' });
    const root = `/api/exhibition/mirrors/${mirrorId}`;
    await jsonRequest(`${root}/binding`, { code: connection.code });
    const mirror = mirrors.getMirror(mirrorId);
    // Exercise the current publication contract with prompt-only presets: no image preparation or keys.
    for (const look of mirror.read().looks) await mirror.updateLook(look.id, {
      mode: 'free', referenceKind: 'none', prompt: 'Isolated gesture HTTP test. No generation is started.',
    });
    await jsonRequest(`${root}/publication/publish`, { expectedRevision: mirror.read().revision });
    assert.equal(mirror.read().publication.legacy, false);
    await jsonRequest(`${root}/command`, { action: 'configure', providerMode: 'xmax', experienceMode: 'free', autoReturnSeconds: 0,
      gestureRecognition: { ...resolveExhibitionGestureSettings(), gestures: ['open_palm', 'wave'] } });
    streams.push({ mirrorId, root, auth: { terminalId, terminalToken }, label: index + 1, sessionId: null,
      epoch: 0, seq: -1, timestamp: index * 10_000, blocked: true, commands: 0, httpMs: [], inferenceMs: [] });
  }
  const warmStarted = performance.now();
  await Promise.all(streams.map(async stream => { stream.sessionId = (await jsonRequest(`${stream.root}/gestures/open`, stream.auth)).sessionId; }));
  const warmupMs = performance.now() - warmStarted;
  assert.notEqual(streams[0].sessionId, streams[1].sessionId);
  await Promise.all(streams.map(stream => control(stream, false, true)));
  const started = performance.now();
  await pair('initial release', blank, blank);
  await pair('A first palm while B stays empty', palm, blank, 9, [true, false]);
  assert.deepEqual(streams.map(stream => stream.commands), [1, 0]);
  await pair('A remains held while B first palm', palm, palm, 9, [false, true]);
  assert.deepEqual(streams.map(stream => stream.commands), [1, 1]);
  await Promise.all(streams.map(stream => control(stream, true)));
  await pair('busy continued palm', palm, palm);
  await pair('busy release', blank, blank);
  await pair('busy new palm', palm, palm);
  for (const moving of movingPalm) await pair('busy moving palm', moving, moving, 1);
  assert.deepEqual(streams.map(stream => stream.commands), [1, 1]);
  await Promise.all(streams.map(stream => control(stream, false)));
  await pair('resume held palm cannot replay', palm, palm, 9);
  await pair('fresh release', blank, blank);
  await pair('fresh palm triggers again', palm, palm, 9, [true, true]);
  assert.deepEqual(streams.map(stream => stream.commands), [2, 2]);
  await pair('second palm remains held', palm, palm);
  assert.deepEqual(streams.map(stream => stream.commands), [2, 2]);
  assert.equal(supplierCalls.length, 0);
  const durationMs = performance.now() - started;
  await Promise.all(streams.map(stream => jsonRequest(`${stream.root}/gestures/close`, { ...stream.auth, sessionId: stream.sessionId })));
  const report = { passed: true, checkedAt: new Date().toISOString(), cpu: cpus()[0]?.model,
    source: sourceUrl, sourceSha256: sourceHash, cropBounds, frameDimensions: { width: 480, height: 640 }, palmJpegBytes: palm.length,
    warmupMs, durationMs, concurrentTerminals: 2, frameRequests: streams.reduce((sum, stream) => sum + stream.httpMs.length, 0),
    gestureCommands: streams.reduce((sum, stream) => sum + stream.commands, 0), supplierCalls: supplierCalls.length,
    requestCounts, streams: streams.map(stream => ({ terminal: stream.label, frames: stream.httpMs.length, commands: stream.commands,
      httpEndToEndMs: percentiles(stream.httpMs), inferenceMs: percentiles(stream.inferenceMs) })),
    checks: ['real binary JPEG HTTP with private terminal bindings', 'explicit published Free presets with no reference preparation', 'separate VIDEO model and detector per terminal',
      'one real open palm selects once', 'holding does not repeat', 'other terminal can trigger independently',
      'busy continuous, newly raised and moving palms are dropped', 'resume does not replay busy palms',
      'release followed by fresh palm selects again', 'zero supplier calls, zero live sessions'],
    limitation: 'Loopback HTTP and host CPU only. Public photo sequence uses a controlled monotonic capture clock; excludes real Android capture, JPEG encoding, Wi-Fi latency and XMAX generation.', trace };
  const output = option('--output');
  if (output) { await mkdir(path.dirname(path.resolve(output)), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify({ ...report, trace: `${trace.length} observations${output ? ` saved to ${output}` : ''}` }, null, 2));
} finally {
  await coordinator.closeAll();
  server.closeAllConnections();
  if (server.listening) { const closed = once(server, 'close'); server.close(); await closed; }
  store.close();
  await rm(directory, { recursive: true, force: true });
}
