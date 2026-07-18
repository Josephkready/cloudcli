import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findStaleToolApprovals,
  reapStaleToolApprovals,
  waitForToolApproval,
  resolveToolApproval,
  parseMsEnv,
  startStaleToolApprovalReaper,
  stopStaleToolApprovalReaper,
} from './claude-sdk.js';

// Reaper for runs abandoned mid tool-approval (#86). Since #62 made approvals
// wait indefinitely, an abandoned run leaks its child process forever; the
// reaper force-denies approvals idle past a generous window so the run finishes
// and gets evicted. `findStaleToolApprovals` is the pure reap-selection policy.

const MINUTE = 60 * 1000;

/** Builds a fake pending-approvals map: resolvers with the metadata the real code attaches. */
function fakePending(entries) {
  const map = new Map();
  for (const [requestId, meta] of Object.entries(entries)) {
    const resolver = () => {};
    Object.assign(resolver, meta);
    map.set(requestId, resolver);
  }
  return map;
}

test('selects only approvals idle at least the threshold', () => {
  const now = Date.now();
  const map = fakePending({
    old: { _receivedAt: new Date(now - 60 * MINUTE), _sessionId: 's1', _toolName: 'Bash' },
    fresh: { _receivedAt: new Date(now - 2 * MINUTE), _sessionId: 's2', _toolName: 'Read' },
  });

  const stale = findStaleToolApprovals(map, now, 45 * MINUTE);

  assert.equal(stale.length, 1);
  assert.equal(stale[0].requestId, 'old');
  assert.equal(stale[0].sessionId, 's1');
  assert.equal(stale[0].toolName, 'Bash');
  assert.equal(stale[0].idleMs, 60 * MINUTE);
});

test('treats the threshold boundary as reapable (>=)', () => {
  const now = Date.now();
  const map = fakePending({ exact: { _receivedAt: new Date(now - 45 * MINUTE), _sessionId: 's1', _toolName: 'Bash' } });

  assert.equal(findStaleToolApprovals(map, now, 45 * MINUTE).length, 1);
  // One ms short of the window is not yet reapable.
  assert.equal(findStaleToolApprovals(map, now, 45 * MINUTE + 1).length, 0);
});

test('a non-positive threshold disables reaping', () => {
  const now = Date.now();
  const map = fakePending({ old: { _receivedAt: new Date(now - 90 * MINUTE), _sessionId: 's1' } });

  assert.deepEqual(findStaleToolApprovals(map, now, 0), []);
  assert.deepEqual(findStaleToolApprovals(map, now, -1), []);
});

test('ignores entries with a missing or non-Date _receivedAt', () => {
  const now = Date.now();
  const map = fakePending({
    noTs: { _sessionId: 's1', _toolName: 'Bash' },
    badTs: { _receivedAt: 'yesterday', _sessionId: 's2' },
  });

  assert.deepEqual(findStaleToolApprovals(map, now, 45 * MINUTE), []);
});

test('null sessionId/toolName default cleanly when metadata is absent', () => {
  const now = Date.now();
  const map = fakePending({ bare: { _receivedAt: new Date(now - 60 * MINUTE) } });

  const [entry] = findStaleToolApprovals(map, now, 45 * MINUTE);
  assert.equal(entry.sessionId, null);
  assert.equal(entry.toolName, null);
});

test('reapStaleToolApprovals force-denies a stale approval and leaves fresh ones pending', async () => {
  const now = Date.now();

  // Register directly into the real pending map via the production helper.
  const stalePromise = waitForToolApproval('reap-test-stale', {
    metadata: { _receivedAt: new Date(now - 60 * MINUTE), _sessionId: 's-stale', _toolName: 'Bash' },
  });
  let freshSettled = false;
  const freshPromise = waitForToolApproval('reap-test-fresh', {
    metadata: { _receivedAt: new Date(now - 1 * MINUTE), _sessionId: 's-fresh', _toolName: 'Read' },
  }).then((d) => {
    freshSettled = true;
    return d;
  });

  try {
    const reaped = reapStaleToolApprovals(now, 45 * MINUTE);

    assert.equal(reaped, 1);
    // The stale approval resolves to null — the same value an auto-deny produces.
    assert.equal(await stalePromise, null);
    assert.equal(freshSettled, false, 'a fresh approval must not be reaped');
  } finally {
    // Always clean up the still-pending fresh entry so a mid-test failure can't
    // leak a permanently-pending entry into the module-global approvals map.
    resolveToolApproval('reap-test-fresh', { approved: true });
  }
  assert.deepEqual(await freshPromise, { approved: true });
});

test('parseMsEnv reads a valid value and falls back on unset/blank', () => {
  const NAME = 'CLOUDCLI_TEST_MS_ENV';
  const original = process.env[NAME];
  try {
    delete process.env[NAME];
    assert.equal(parseMsEnv(NAME, 42), 42);
    process.env[NAME] = '   ';
    assert.equal(parseMsEnv(NAME, 42), 42);
    process.env[NAME] = '1500';
    assert.equal(parseMsEnv(NAME, 42), 1500);
    process.env[NAME] = '0';
    assert.equal(parseMsEnv(NAME, 42), 0);
  } finally {
    if (original === undefined) delete process.env[NAME];
    else process.env[NAME] = original;
  }
});

test('parseMsEnv warns and falls back on a malformed or negative value', () => {
  const NAME = 'CLOUDCLI_TEST_MS_ENV';
  const original = process.env[NAME];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    // Unit-suffixed typos (the classic "45m" instead of 2700000) and floats
    // must warn, not silently truncate to a bogus ms value.
    for (const bad of ['not-a-number', '-5', '45m', '10abc', '1.5']) {
      process.env[NAME] = bad;
      assert.equal(parseMsEnv(NAME, 99), 99, `"${bad}" should fall back`);
    }
    assert.equal(warnings.length, 5);
    assert.ok(warnings.every((w) => w.includes(NAME)), 'each warning names the offending env var');
  } finally {
    console.warn = originalWarn;
    if (original === undefined) delete process.env[NAME];
    else process.env[NAME] = original;
  }
});

test('startStaleToolApprovalReaper fires the reaper on its interval; stop halts it', async (t) => {
  // Drive the interval with mock timers so the tick is deterministic. The reaper's
  // setInterval is unref'd (it must not keep the process alive in production), so
  // under real timers the process can exit before a real tick fires — cancelling
  // this test and the next as `cancelledByParent` (#135). A mock tick removes the
  // wall-clock race entirely. Only setInterval is faked; Date stays real so the
  // reap-window comparison against `_receivedAt` still holds.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const now = Date.now();
  // 90 min idle — well past the default 45 min reap window used by the timer.
  const pending = waitForToolApproval('reaper-timer-test', {
    metadata: { _receivedAt: new Date(now - 90 * MINUTE), _sessionId: 's-timer', _toolName: 'Bash' },
  });
  try {
    startStaleToolApprovalReaper(10);
    t.mock.timers.tick(10); // one interval elapses → the reaper force-denies the stale approval
    // Resolves to null once an interval tick force-denies the stale approval.
    assert.equal(await pending, null);

    // ...and stop halts it: a fresh stale approval registered after stop survives
    // further ticks, proving the interval was cleared (no reaper runs post-stop).
    stopStaleToolApprovalReaper();
    let survivorSettled = false;
    const survivor = waitForToolApproval('reaper-timer-survivor', {
      metadata: { _receivedAt: new Date(now - 90 * MINUTE), _sessionId: 's-timer-2', _toolName: 'Bash' },
    }).then((d) => {
      survivorSettled = true;
      return d;
    });
    t.mock.timers.tick(10 * 100); // advance far past many intervals — nothing should fire
    await Promise.resolve(); // drain microtasks so a stray resolution would be observed
    assert.equal(survivorSettled, false, 'stop() must halt the reaper — no tick fires after stop');
    // Clean up the still-pending survivor so it can't leak into the module-global map.
    resolveToolApproval('reaper-timer-survivor', { approved: true });
    assert.deepEqual(await survivor, { approved: true });
  } finally {
    stopStaleToolApprovalReaper();
  }
});

test('startStaleToolApprovalReaper is idempotent and stop is safe when not running', (t) => {
  // Starting twice must not spin up a second timer; stopping repeatedly (including
  // when never started) must be a safe no-op. Spy on setInterval to assert the
  // second start is a true no-op rather than just not throwing.
  const setIntervalSpy = t.mock.method(global, 'setInterval');
  try {
    startStaleToolApprovalReaper(60_000);
    startStaleToolApprovalReaper(60_000);
    assert.equal(setIntervalSpy.mock.callCount(), 1, 'a second start must not create a second timer');
  } finally {
    stopStaleToolApprovalReaper();
    stopStaleToolApprovalReaper();
  }
});
