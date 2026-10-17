import { randomUUID as newCommandId } from 'node:crypto';

const DIRECTIONS = new Map([[75, -1], [78, 1], [79, 1], [80, -1], [81, 1], [82, -1]]);
const MIRROR_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BINDING_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LINUX_STABLE_PATH = /^\/dev\/input\/(?:by-id|by-path)\/[^/\x00]+$/;
const LINUX_EVENT_PATH = /^\/dev\/input\/event[0-9]+$/;
const LIVE_LEASE_MS = 20_000;
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** The service and native receiver use the same physical-device binding file. */
export function validatePresenterConfig(config) {
  if (!record(config) || !Array.isArray(config.bindings) || !config.bindings.length) throw new Error('翻页笔绑定配置无效。');
  let base;
  try { base = new URL(config.apiBaseUrl); } catch { throw new Error('翻页笔后台地址无效。'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || !/^\/v1\.1\/api\/exhibition\/?$/.test(base.pathname)) throw new Error('翻页笔后台地址无效。');
  const ids = new Set(); const mirrors = new Set(); const selectors = [];
  const bindings = config.bindings.map(binding => {
    if (!record(binding) || typeof binding.id !== 'string' || !BINDING_ID.test(binding.id)
      || typeof binding.mirrorId !== 'string' || !MIRROR_ID.test(binding.mirrorId)
      || !Number.isInteger(binding.vendorId) || binding.vendorId < 1 || binding.vendorId > 65_535
      || !Number.isInteger(binding.productId) || binding.productId < 0 || binding.productId > 65_535
      || (binding.locationId != null && (!Number.isInteger(binding.locationId) || binding.locationId < 1 || binding.locationId > 0xffffffff))
      || (binding.serialNumber != null && (typeof binding.serialNumber !== 'string' || !binding.serialNumber.trim()))) {
      throw new Error('翻页笔设备绑定无效。');
    }
    const linuxPath = binding.linuxDevicePath ?? binding.byPath;
    const linux = linuxPath !== undefined;
    if (linux) {
      if (typeof linuxPath !== 'string' || !(LINUX_STABLE_PATH.test(linuxPath) || LINUX_EVENT_PATH.test(linuxPath))
        || linuxPath.split('/').some(part => part === '.' || part === '..')
        || (binding.linuxDevicePath != null && binding.byPath != null && binding.linuxDevicePath !== binding.byPath)
        || (LINUX_EVENT_PATH.test(linuxPath) && !binding.phys)
        || ['phys', 'uniq'].some(field => binding[field] != null
          && (typeof binding[field] !== 'string' || !binding[field].trim() || binding[field].includes('\0')))
        || binding.locationId != null || binding.serialNumber != null) {
        throw new Error('翻页笔 Linux 设备绑定无效。');
      }
    } else if (binding.locationId == null && binding.serialNumber == null) {
      throw new Error('翻页笔设备绑定无效。');
    }
    if (selectors.some(other => Boolean(other.linuxDevicePath) !== linux)) throw new Error('翻页笔配置不能混用不同系统的设备路径。');
    const overlaps = selectors.some(other => linux
      ? other.linuxDevicePath === linuxPath || (other.vendorId === binding.vendorId && other.productId === binding.productId
        && ((binding.phys && other.phys === binding.phys) || (binding.uniq && other.uniq === binding.uniq)))
      : other.vendorId === binding.vendorId && other.productId === binding.productId
      && !(other.locationId != null && binding.locationId != null && other.locationId !== binding.locationId)
      && !(other.serialNumber != null && binding.serialNumber != null && other.serialNumber !== binding.serialNumber));
    if (ids.has(binding.id) || overlaps || mirrors.has(binding.mirrorId)) throw new Error('每支翻页笔须独立绑定一台设备。');
    const normalized = { id: binding.id, mirrorId: binding.mirrorId, vendorId: binding.vendorId, productId: binding.productId,
      ...(binding.locationId == null ? {} : { locationId: binding.locationId }),
      ...(binding.serialNumber == null ? {} : { serialNumber: binding.serialNumber }),
      ...(linux ? { linuxDevicePath: linuxPath } : {}),
      ...(!linux || binding.phys == null ? {} : { phys: binding.phys }),
      ...(!linux || binding.uniq == null ? {} : { uniq: binding.uniq }) };
    ids.add(binding.id); mirrors.add(binding.mirrorId); selectors.push(normalized);
    return normalized;
  });
  return { apiBaseUrl: base.href.replace(/\/$/, ''), bindings };
}

function validState(state, mirrorId) {
  return record(state) && state.mirrorId === mirrorId && Number.isSafeInteger(state.revision) && state.revision >= 0
    && ['idle', 'select', 'positioning', 'generating', 'showcase', 'paused'].includes(state.phase)
    && ['demo', 'xmax'].includes(state.providerMode) && typeof state.experienceMode === 'string'
    && (state.selectedLookId === null || typeof state.selectedLookId === 'string')
    && (state.live == null || record(state.live)) && (state.lifecycle == null || record(state.lifecycle));
}

function blockedState(state, now) {
  if (!['idle', 'select', 'generating', 'showcase'].includes(state.phase)) return 'phase';
  // An ended lifecycle with no remaining lease is a normal, selectable standby screen.
  if (state.lifecycle && !['idle', 'running'].includes(state.lifecycle.connection)) return 'connection';
  if (['idle', 'select'].includes(state.phase)) return state.live ? 'live_pending' : null;
  if (state.lifecycle && state.lifecycle.state !== 'active') return 'lifecycle';
  if (state.providerMode !== 'xmax') return state.live ? 'unexpected_live' : null;
  const live = state.live;
  if (!live || live.status !== 'running' || !live.sessionId || live.localEnded || live.renewal) return 'live_pending';
  if (live.generationNumber !== state.generationNumber || live.lookId !== state.selectedLookId) return 'selection_pending';
  if (!Number.isFinite(live.heartbeatAt) || now - live.heartbeatAt >= LIVE_LEASE_MS || live.heartbeatAt > now + LIVE_LEASE_MS) return 'offline';
  return null;
}

/** Match catalog.ts: catalog order, current mode, and the server's provider availability. */
function orderedLooks(state) {
  const looks = state.providerMode === 'xmax' ? state.catalog?.looks : state.looks;
  const enabledIds = state.providerMode === 'xmax' ? state.catalog?.availableLookIds : state.enabledLookIds;
  if (!Array.isArray(looks) || !Array.isArray(enabledIds) || enabledIds.some(id => typeof id !== 'string')) return null;
  const enabled = new Set(enabledIds); const seen = new Set();
  const result = [];
  for (const look of looks) {
    if (!record(look) || typeof look.id !== 'string' || seen.has(look.id)) return null;
    seen.add(look.id);
    if (enabled.has(look.id) && (look.mode ?? 'clothx') === state.experienceMode) result.push(look);
  }
  return result;
}

/**
 * Accept native HID JSON events. No window focus, browser identities or cloud keys
 * are involved. Each press reads its bound mirror afresh, then sends at most one
 * selection command; failures and presses received while busy are never replayed.
 */
export function createPresenterRouter(config, {
  fetchImpl = globalThis.fetch,
  onEvent = () => {},
  now = Date.now,
  randomUUID = newCommandId,
  requestTimeoutMs = 2_000,
  maxPressAgeMs = 1_500,
} = {}) {
  const validated = validatePresenterConfig(config);
  if (typeof fetchImpl !== 'function' || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0
    || !Number.isFinite(maxPressAgeMs) || maxPressAgeMs <= 0) throw new Error('翻页笔路由参数无效。');
  const origin = new URL(validated.apiBaseUrl).origin;
  const bindings = new Map(validated.bindings.map(binding => [binding.id, { binding, held: new Set(), epoch: 0, pending: null }]));

  const report = (runtime, status, details = {}) => {
    const event = { type: 'presenter', bindingId: runtime.binding.id, mirrorId: runtime.binding.mirrorId, status, ...details };
    // A broken log sink must never replay or interrupt an already-sent command.
    try { onEvent(event); } catch { /* Reporting is independent of control. */ }
    return event;
  };
  const release = bindingId => {
    const runtime = bindings.get(bindingId);
    if (!runtime) return;
    runtime.epoch++;
    runtime.held.clear();
    runtime.pending?.controller.abort();
    runtime.pending = null;
  };
  const releaseAll = () => { for (const id of bindings.keys()) release(id); };
  const request = async (url, operation, init = {}) => {
    const timer = setTimeout(() => operation.controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(url, { cache: 'no-store', redirect: 'error', ...init, signal: operation.controller.signal });
      if (!response.ok) throw new Error(`http_${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); }
  };

  const handle = async event => {
    if (!record(event)) return { status: 'ignored', reason: 'invalid_event' };
    const runtime = bindings.get(event.bindingId);
    if (!runtime) return { status: 'ignored', reason: 'unknown_binding' };
    if (['connected', 'disconnected'].includes(event.type) || (event.type === 'device' && typeof event.connected === 'boolean')) {
      release(event.bindingId);
      return report(runtime, event.type === 'connected' || event.connected === true ? 'connected' : 'disconnected');
    }
    if (event.type !== 'key' || (event.usagePage !== undefined && event.usagePage !== 7)
      || !DIRECTIONS.has(event.usage) || ![0, 1].includes(event.value)) return { status: 'ignored', reason: 'unsupported_key' };
    if (event.value === 0) {
      runtime.held.delete(event.usage);
      return { status: 'ignored', reason: 'released' };
    }
    if (runtime.held.has(event.usage)) return { status: 'ignored', reason: 'held' };
    runtime.held.add(event.usage);
    if (runtime.pending) return { status: 'ignored', reason: 'busy' };

    const operation = { controller: new AbortController(), epoch: runtime.epoch, pressedAt: now() };
    runtime.pending = operation;
    const current = () => runtime.pending === operation && runtime.epoch === operation.epoch && !operation.controller.signal.aborted;
    const mirrorUrl = `${validated.apiBaseUrl}/mirrors/${encodeURIComponent(runtime.binding.mirrorId)}`;
    let sent = false;
    try {
      const state = await request(mirrorUrl, operation);
      if (!current()) return { status: 'ignored', reason: 'cancelled' };
      if (!validState(state, runtime.binding.mirrorId)) return report(runtime, 'blocked', { reason: 'invalid_state' });
      const blocked = blockedState(state, now());
      if (blocked) return report(runtime, 'blocked', { reason: blocked });
      const looks = orderedLooks(state);
      if (!looks) return report(runtime, 'blocked', { reason: 'invalid_catalog' });
      if (looks.length < 2) return report(runtime, 'blocked', { reason: 'no_adjacent_material' });
      const direction = DIRECTIONS.get(event.usage);
      const index = looks.findIndex(look => look.id === state.selectedLookId);
      const target = looks[index < 0 ? direction > 0 ? 0 : looks.length - 1 : (index + direction + looks.length) % looks.length];
      const action = ['idle', 'select'].includes(state.phase) ? 'select' : 'switch';
      const command = { action, lookId: target.id, commandId: randomUUID(), expectedRevision: state.revision };
      // release() fences reads that were in flight when a receiver was unplugged.
      if (!current()) return { status: 'ignored', reason: 'cancelled' };
      if (now() - operation.pressedAt > maxPressAgeMs) return report(runtime, 'blocked', { reason: 'expired_press' });
      sent = true;
      const accepted = await request(`${mirrorUrl}/command`, operation, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(command) });
      if (!current()) return { status: 'ignored', reason: 'cancelled' };
      if (!validState(accepted, runtime.binding.mirrorId) || accepted.selectedLookId !== target.id || accepted.revision < state.revision) {
        return report(runtime, 'error', { reason: 'unconfirmed_command' });
      }
      return report(runtime, 'accepted', { action, lookId: target.id });
    } catch (error) {
      if (runtime.epoch !== operation.epoch || runtime.pending !== operation) return { status: 'ignored', reason: 'cancelled' };
      const reason = /^http_\d{3}$/.test(error?.message ?? '') ? error.message
        : operation.controller.signal.aborted ? 'timeout' : 'network_error';
      return report(runtime, 'error', { reason, sent });
    } finally {
      if (runtime.pending === operation) runtime.pending = null;
    }
  };
  return { handle, release, releaseAll };
}
