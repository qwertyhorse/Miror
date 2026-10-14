/** Protocol policy shared by the server and terminals. Never a cumulative spending budget. */
export const EXHIBITION_PROTOCOL = 2;
export const LEASE_TTL_MS = 20_000;
export const LEASE_SAFETY_MS = 2_000;
export const HEARTBEAT_INTERVAL_MS = 3_000;
export const HEARTBEAT_REQUEST_MS = 4_000;
export const RECOVERY_WINDOW_MS = 300_000;
export const RECOVERY_STABLE_MS = 60_000;
export type StopReason = 'user_end' | 'staff_pause' | 'idle_end' | 'lease_expired' | 'credential_expired'
  | 'segment_exhausted' | 'provider_rejected' | 'camera_lost' | 'rtc_failed' | 'command_unknown'
  | 'issue_unknown' | 'stop_unknown' | 'shutdown' | 'mode_changed' | 'mox_completed';
export const STOP_REASONS: readonly StopReason[] = ['user_end', 'staff_pause', 'idle_end', 'lease_expired',
  'credential_expired', 'segment_exhausted', 'provider_rejected', 'camera_lost', 'rtc_failed',
  'command_unknown', 'issue_unknown', 'stop_unknown', 'shutdown', 'mode_changed', 'mox_completed'];
export function isStopReason(value: unknown): value is StopReason { return STOP_REASONS.includes(value as StopReason); }

/** Receipt deadlines use request START, not response arrival or the device's wall clock. */
export class TerminalLease {
  private deadline = -Infinity;
  constructor(private readonly now: () => number = () => performance.now()) {}
  acknowledge(sentAt: number, ttlMs = LEASE_TTL_MS) {
    if (!Number.isFinite(sentAt) || sentAt > this.now() || !Number.isFinite(ttlMs) || ttlMs <= LEASE_SAFETY_MS || ttlMs > LEASE_TTL_MS) return;
    this.deadline = Math.max(this.deadline, sentAt + ttlMs - LEASE_SAFETY_MS);
  }
  remaining() { return Math.max(0, this.deadline - this.now()); }
}

export interface ExperienceLifecycle {
  protocol: 2; experienceId: string | null; state: 'idle' | 'active' | 'paused' | 'ended';
  controllerEpoch: number; terminalRevision: number; policyVersion: 1;
  connection: 'idle' | 'connecting' | 'running' | 'recovering' | 'needs_assistance' | 'cleaning';
  reason?: StopReason; recoveryAttempts: number[]; consecutiveFailures: number;
  idleEndsAt?: number; healthySince?: number; retryAt?: number; ownerDeviceId?: string;
}
export function initialLifecycle(): ExperienceLifecycle {
  return { protocol: EXHIBITION_PROTOCOL, experienceId: null, state: 'idle', controllerEpoch: 0, terminalRevision: 0,
    policyVersion: 1, connection: 'idle', recoveryAttempts: [], consecutiveFailures: 0 };
}
export function admitRecovery(state: ExperienceLifecycle, now: number, planned = false): boolean {
  state.recoveryAttempts = state.recoveryAttempts.filter(at => at > now - RECOVERY_WINDOW_MS);
  if (state.healthySince !== undefined && now - state.healthySince >= RECOVERY_STABLE_MS) state.consecutiveFailures = 0;
  if (planned) return state.state === 'active';
  if (state.state !== 'active' || state.consecutiveFailures >= 2 || state.recoveryAttempts.length >= 3) return false;
  state.consecutiveFailures++; state.recoveryAttempts.push(now); delete state.healthySince;
  return true;
}

/** Reject incompatible or corrupt durable authority instead of silently recreating it. */
export function isExperienceLifecycle(value: unknown): value is ExperienceLifecycle {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  const integer = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  return state.protocol === 2 && state.policyVersion === 1
    && (state.experienceId === null || (typeof state.experienceId === 'string' && state.experienceId.length > 0))
    && ['idle', 'active', 'paused', 'ended'].includes(state.state as string)
    && ['idle', 'connecting', 'running', 'recovering', 'needs_assistance', 'cleaning'].includes(state.connection as string)
    && integer(state.controllerEpoch) && integer(state.terminalRevision) && integer(state.consecutiveFailures)
    && Array.isArray(state.recoveryAttempts) && state.recoveryAttempts.length <= 3 && state.recoveryAttempts.every(integer)
    && (state.reason === undefined || isStopReason(state.reason))
    && ['idleEndsAt', 'healthySince', 'retryAt'].every(key => state[key] === undefined || integer(state[key]))
    && (state.ownerDeviceId === undefined || typeof state.ownerDeviceId === 'string');
}
