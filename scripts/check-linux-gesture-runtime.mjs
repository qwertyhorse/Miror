import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cpus, platform, arch } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createGestureInference } from '../server/gestureInference.ts';

// Official MediaPipe Python example image, fetched into memory only; never a live camera or cloud session.
const sourceUrl = 'https://storage.googleapis.com/mediapipe-tasks/hand_landmarker/woman_hands.jpg';
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const frames = Number(option('--frames') ?? 60);
assert(Number.isSafeInteger(frames) && frames >= 5 && frames <= 1000);
const source = option('--sample') ? await readFile(option('--sample')) : Buffer.from(await (await fetch(sourceUrl, { signal: AbortSignal.timeout(20_000) })).arrayBuffer());
assert(source.length < 8 * 1024 * 1024);
const jpeg = await sharp(source).resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
const alternate = await sharp(jpeg).flop().jpeg({ quality: 82 }).toBuffer();
const oversize = await sharp({ create: { width: 641, height: 8, channels: 3, background: '#fff' } }).jpeg().toBuffer();
const settings = { minHandDetectionConfidence: .5, minHandPresenceConfidence: .5, minTrackingConfidence: .5 };
const started = performance.now();
const workers = await Promise.all([createGestureInference(), createGestureInference()]);
const startupMs = performance.now() - started;
const percentiles = values => {
  const sorted = values.slice().sort((a, b) => a - b);
  return { p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))], max: sorted.at(-1), mean: values.reduce((a, b) => a + b, 0) / values.length };
};
try {
  await assert.rejects(workers[0].infer(oversize, 0, settings), { code: 'INVALID_IMAGE' });
  await assert.rejects(workers[0].infer(Buffer.from([255, 216, 255, 217]), 1, settings), { code: 'INVALID_IMAGE' });
  const first = workers[0].infer(jpeg, 2, settings);
  await assert.rejects(workers[0].infer(jpeg, 3, settings), { code: 'INFERENCE_BUSY' });
  assert((await first).hands.length > 0, 'Official sample must detect real hand landmarks');
  const benchmarkStarted = performance.now();
  const streams = await Promise.all(workers.map(async (worker, index) => {
    const elapsed = [], inference = [], hands = [];
    for (let frame = 0; frame < frames; frame++) {
      const at = performance.now();
      const result = await worker.infer(index === 0 ? jpeg : alternate, 1000 + frame * 100, settings);
      elapsed.push(performance.now() - at); inference.push(result.inferenceMs); hands.push(result.hands.length);
      assert.equal(result.poses.length, 0);
      assert(result.width <= 640 && result.height <= 640 && result.hands.length > 0);
      for (const hand of result.hands) assert.equal(hand.landmarks.length, 21);
    }
    return { terminal: index + 1, frames, endToEndMs: percentiles(elapsed), inferenceMs: percentiles(inference), minimumHands: Math.min(...hands), maximumHands: Math.max(...hands) };
  }));
  const durationMs = performance.now() - benchmarkStarted;
  const root = fileURLToPath(new URL('../', import.meta.url));
  const report = { passed: true, checkedAt: new Date().toISOString(), platform: `${platform()} ${arch()}`, cpu: cpus()[0]?.model,
    modelSha256: createHash('sha256').update(await readFile(path.join(root, 'public/assets/exhibition-gestures/hand_landmarker.task'))).digest('hex'),
    source: option('--sample') ?? sourceUrl, sourceSha256: createHash('sha256').update(source).digest('hex'), jpegBytes: jpeg.length,
    startupMs, durationMs, concurrentTerminals: 2, totalFramesPerSecond: frames * 2 * 1000 / durationMs, streams,
    checks: ['actual CPU model warmup', 'oversize JPEG header rejected', 'corrupt JPEG rejected', 'overlapping frame rejected', 'two isolated VIDEO models detect real hands'],
    limitation: 'Host CPU inference and local pipes only; excludes Android capture, JPEG encoding, LAN transport and XMAX generation.' };
  const output = option('--output');
  if (output) { await mkdir(path.dirname(path.resolve(output)), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify(report, null, 2));
} finally { await Promise.all(workers.map(worker => worker.close())); }
