import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadWithRetry } from './lazySurface.pure';

const noWait = async () => {};

describe('loadWithRetry', () => {
  it('returns the module without retrying when the first attempt succeeds', async () => {
    let calls = 0;
    const result = await loadWithRetry(
      async () => {
        calls += 1;
        return 'chunk';
      },
      { wait: noWait },
    );

    assert.equal(result, 'chunk');
    assert.equal(calls, 1);
  });

  it('recovers from a transient failure', async () => {
    let calls = 0;
    const result = await loadWithRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('network hiccup');
        return 'chunk';
      },
      { wait: noWait },
    );

    assert.equal(result, 'chunk');
    assert.equal(calls, 2);
  });

  it('rethrows the last error once the retries are spent', async () => {
    let calls = 0;
    await assert.rejects(
      loadWithRetry(
        async () => {
          calls += 1;
          throw new Error(`attempt ${calls}`);
        },
        { wait: noWait },
      ),
      /attempt 2/,
    );

    assert.equal(calls, 2);
  });

  it('honours a larger retry budget', async () => {
    let calls = 0;
    const result = await loadWithRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('still failing');
        return 'chunk';
      },
      { retries: 2, wait: noWait },
    );

    assert.equal(result, 'chunk');
    assert.equal(calls, 3);
  });

  it('makes exactly one attempt when retries are disabled', async () => {
    let calls = 0;
    await assert.rejects(
      loadWithRetry(
        async () => {
          calls += 1;
          throw new Error('nope');
        },
        { retries: 0, wait: noWait },
      ),
      /nope/,
    );

    assert.equal(calls, 1);
  });

  it('waits between attempts, and only between attempts', async () => {
    const delays: number[] = [];
    let calls = 0;

    await loadWithRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        return 'chunk';
      },
      {
        delayMs: 42,
        wait: async (ms) => {
          delays.push(ms);
        },
      },
    );

    assert.deepEqual(delays, [42]);
  });
});
