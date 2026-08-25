export type LoginAttemptDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; reason: 'ip' | 'username' };

type LoginAttemptLimiterOptions = {
  clock?: () => number;
  ipMaxAttempts?: number;
  ipWindowMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  maxFailures?: number;
  lockoutMs?: number;
  failureResetMs?: number;
  inFlightMs?: number;
  maxEntries?: number;
  sweepIntervalMs?: number;
};

type IpAttemptState = {
  attempts: number[];
  lastSeenAt: number;
};

type UsernameAttemptState = {
  failures: number;
  lastFailureAt: number | null;
  blockedUntil: number;
  inFlightUntil: number;
  lastSeenAt: number;
};

const OVERFLOW_KEY = Symbol('login-attempt-overflow');

const DEFAULT_OPTIONS = {
  ipMaxAttempts: 10,
  ipWindowMs: 60_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  maxFailures: 5,
  lockoutMs: 15 * 60_000,
  failureResetMs: 30 * 60_000,
  inFlightMs: 10_000,
  maxEntries: 10_000,
  sweepIntervalMs: 60_000,
} as const;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.floor(value)
    : fallback;
}

function retryAfterSeconds(blockedUntil: number, now: number): number {
  return Math.max(1, Math.ceil((blockedUntil - now) / 1_000));
}

export function normalizeLoginUsername(username: string): string {
  return username.slice(0, 512).normalize('NFKC').trim().toLowerCase().slice(0, 256) || '<empty>';
}

export function normalizeLoginClientAddress(clientAddress: string): string {
  return clientAddress.trim().slice(0, 128) || '<unknown>';
}

/**
 * Bounds expensive login work per direct client and applies escalating account
 * backoff after failures. State is intentionally process-local: CloudCLI runs
 * as one server process, and no credential or raw password is persisted.
 */
export class LoginAttemptLimiter {
  private readonly clock: () => number;
  private readonly ipMaxAttempts: number;
  private readonly ipWindowMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxFailures: number;
  private readonly lockoutMs: number;
  private readonly failureResetMs: number;
  private readonly inFlightMs: number;
  private readonly maxEntries: number;
  private readonly sweepIntervalMs: number;
  private readonly ipAttempts = new Map<string | symbol, IpAttemptState>();
  private readonly usernameAttempts = new Map<string | symbol, UsernameAttemptState>();
  private lastSweepAt = 0;

  constructor(options: LoginAttemptLimiterOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.ipMaxAttempts = positiveInteger(options.ipMaxAttempts, DEFAULT_OPTIONS.ipMaxAttempts);
    this.ipWindowMs = positiveInteger(options.ipWindowMs, DEFAULT_OPTIONS.ipWindowMs);
    this.backoffBaseMs = positiveInteger(options.backoffBaseMs, DEFAULT_OPTIONS.backoffBaseMs);
    this.backoffMaxMs = positiveInteger(options.backoffMaxMs, DEFAULT_OPTIONS.backoffMaxMs);
    this.maxFailures = positiveInteger(options.maxFailures, DEFAULT_OPTIONS.maxFailures);
    this.lockoutMs = positiveInteger(options.lockoutMs, DEFAULT_OPTIONS.lockoutMs);
    this.failureResetMs = positiveInteger(options.failureResetMs, DEFAULT_OPTIONS.failureResetMs);
    this.inFlightMs = positiveInteger(options.inFlightMs, DEFAULT_OPTIONS.inFlightMs);
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_OPTIONS.maxEntries);
    this.sweepIntervalMs = positiveInteger(options.sweepIntervalMs, DEFAULT_OPTIONS.sweepIntervalMs);
  }

  beginAttempt(clientAddress: string, username: string): LoginAttemptDecision {
    const now = this.clock();
    this.maybeSweep(now);

    const ipKey = normalizeLoginClientAddress(clientAddress);
    const ipState = this.getOrCreateIpState(ipKey, now);
    const cutoff = now - this.ipWindowMs;
    ipState.attempts = ipState.attempts.filter((attemptedAt) => attemptedAt > cutoff);
    ipState.lastSeenAt = now;
    if (ipState.attempts.length >= this.ipMaxAttempts) {
      return {
        allowed: false,
        retryAfterSeconds: retryAfterSeconds(ipState.attempts[0] + this.ipWindowMs, now),
        reason: 'ip',
      };
    }
    // Reserve the IP budget synchronously before bcrypt starts so a parallel
    // burst cannot send every request through the worker pool at once.
    ipState.attempts.push(now);

    const usernameKey = normalizeLoginUsername(username);
    const usernameState = this.getOrCreateUsernameState(usernameKey, now);
    this.resetStaleFailures(usernameState, now);
    usernameState.lastSeenAt = now;
    const blockedUntil = Math.max(usernameState.blockedUntil, usernameState.inFlightUntil);
    if (blockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: retryAfterSeconds(blockedUntil, now),
        reason: 'username',
      };
    }

    // Serialize password checks for one normalized username across client IPs.
    usernameState.inFlightUntil = now + this.inFlightMs;
    return { allowed: true };
  }

  recordFailure(username: string): void {
    const now = this.clock();
    const usernameKey = normalizeLoginUsername(username);
    const state = this.getOrCreateUsernameState(usernameKey, now);
    this.resetStaleFailures(state, now);
    state.failures += 1;
    state.lastFailureAt = now;
    state.lastSeenAt = now;
    state.inFlightUntil = 0;

    const backoff = state.failures >= this.maxFailures
      ? this.lockoutMs
      : Math.min(this.backoffBaseMs * (2 ** (state.failures - 1)), this.backoffMaxMs);
    state.blockedUntil = now + backoff;
  }

  recordSuccess(username: string): void {
    const usernameKey = this.resolveBoundedKey(
      this.usernameAttempts,
      normalizeLoginUsername(username),
    );
    this.usernameAttempts.delete(usernameKey);
  }

  cancelAttempt(username: string): void {
    const usernameKey = this.resolveBoundedKey(
      this.usernameAttempts,
      normalizeLoginUsername(username),
    );
    const state = this.usernameAttempts.get(usernameKey);
    if (!state) return;
    state.inFlightUntil = 0;
    if (state.failures === 0) {
      this.usernameAttempts.delete(usernameKey);
    }
  }

  private getOrCreateIpState(key: string, now: number): IpAttemptState {
    const boundedKey = this.resolveBoundedKey(this.ipAttempts, key);
    const existing = this.ipAttempts.get(boundedKey);
    if (existing) return existing;
    const created = { attempts: [], lastSeenAt: now };
    this.ipAttempts.set(boundedKey, created);
    return created;
  }

  private getOrCreateUsernameState(key: string, now: number): UsernameAttemptState {
    const boundedKey = this.resolveBoundedKey(this.usernameAttempts, key);
    const existing = this.usernameAttempts.get(boundedKey);
    if (existing) return existing;
    const created = {
      failures: 0,
      lastFailureAt: null,
      blockedUntil: 0,
      inFlightUntil: 0,
      lastSeenAt: now,
    };
    this.usernameAttempts.set(boundedKey, created);
    return created;
  }

  private resolveBoundedKey<T>(entries: Map<string | symbol, T>, key: string): string | symbol {
    if (entries.has(key)) return key;
    // Reserve the final slot for a shared fail-secure bucket. Once the map is
    // full, attacker-controlled unique IPs/usernames cannot evict a real
    // account's active lockout or grow process memory without bound.
    return entries.size < this.maxEntries - 1 ? key : OVERFLOW_KEY;
  }

  private resetStaleFailures(state: UsernameAttemptState, now: number): void {
    if (state.blockedUntil > now) return;
    const completedLockout = state.failures >= this.maxFailures;
    const failureWindowExpired = state.lastFailureAt !== null
      && now - state.lastFailureAt >= this.failureResetMs;
    if (completedLockout || failureWindowExpired) {
      state.failures = 0;
      state.lastFailureAt = null;
      state.blockedUntil = 0;
    }
  }

  private maybeSweep(now: number): void {
    if (now - this.lastSweepAt < this.sweepIntervalMs) return;
    this.lastSweepAt = now;
    const ipCutoff = now - this.ipWindowMs;
    for (const [key, state] of this.ipAttempts) {
      state.attempts = state.attempts.filter((attemptedAt) => attemptedAt > ipCutoff);
      if (state.attempts.length === 0) this.ipAttempts.delete(key);
    }
    for (const [key, state] of this.usernameAttempts) {
      const inactive = state.inFlightUntil <= now && state.blockedUntil <= now;
      const failuresExpired = state.lastFailureAt === null
        || now - state.lastFailureAt >= this.failureResetMs;
      if (inactive && failuresExpired) this.usernameAttempts.delete(key);
    }
  }
}
