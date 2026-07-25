import assert from 'node:assert/strict';
import test from 'node:test';

import type { FeatureKey } from '../../shared/featureKeys';
import { createLocalStorage, withGlobals } from '../test/nodeStubs';

import {
  __flushFeatureUsageForTests,
  __pendingFeatureUsesForTests,
  __resetFeatureUsageForTests,
  recordFeatureUse,
} from './featureUsage';

type FetchCall = { url: string; keys: FeatureKey[]; keepalive: boolean };

/**
 * Runs `fn` with a stubbed `fetch`/`localStorage`/`window`, returning every
 * `/api/usage` POST the flush made. `respond` shapes what the server "returns".
 */
function withStubbedFetch(
  respond: () => Promise<unknown>,
  fn: (calls: FetchCall[]) => void,
): FetchCall[] {
  const calls: FetchCall[] = [];
  const fetchStub = (url: string, options: RequestInit = {}) => {
    calls.push({
      url,
      keys: JSON.parse(String(options.body)).keys as FeatureKey[],
      keepalive: options.keepalive === true,
    });
    return respond();
  };

  __resetFeatureUsageForTests();
  try {
    withGlobals(
      {
        fetch: fetchStub,
        localStorage: createLocalStorage(),
        window: { addEventListener: () => {} },
      },
      () => fn(calls),
    );
  } finally {
    __resetFeatureUsageForTests();
  }
  return calls;
}

/** A `fetch` that resolves like the real endpoint does. */
const okResponse = (body: unknown = { enabled: true, recorded: 1 }) =>
  Promise.resolve({
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response);

test('recordFeatureUse buffers keys and flushes them as one batch', () => {
  const calls = withStubbedFetch(
    () => okResponse(),
    () => {
      recordFeatureUse('chat.send');
      recordFeatureUse('chat.send');
      recordFeatureUse('git.commit');

      // Nothing goes out until the flush; the batch is what limits a chatty
      // surface to one request instead of one per click.
      assert.deepEqual([...__pendingFeatureUsesForTests()], [
        'chat.send',
        'chat.send',
        'git.commit',
      ]);

      __flushFeatureUsageForTests();
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, '/api/usage');
  assert.deepEqual(calls[0]?.keys, ['chat.send', 'chat.send', 'git.commit']);
  assert.equal(calls[0]?.keepalive, false);
});

test('a flush with nothing buffered makes no request', () => {
  const calls = withStubbedFetch(
    () => okResponse(),
    () => {
      __flushFeatureUsageForTests();
    },
  );

  assert.equal(calls.length, 0);
});

test('a throwing fetch never propagates to the caller', () => {
  const calls = withStubbedFetch(
    () => {
      throw new Error('network is down');
    },
    () => {
      assert.doesNotThrow(() => {
        recordFeatureUse('chat.send');
        __flushFeatureUsageForTests();
      });
    },
  );

  assert.equal(calls.length, 1);
});

test('a rejecting fetch never produces an unhandled rejection', async () => {
  withStubbedFetch(
    () => Promise.reject(new Error('offline')),
    () => {
      assert.doesNotThrow(() => {
        recordFeatureUse('git.commit');
        __flushFeatureUsageForTests();
      });
    },
  );

  // If the rejection were unhandled, the process would emit a warning before
  // this microtask/macrotask boundary resolves.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('a missing fetch global never propagates to the caller', () => {
  __resetFeatureUsageForTests();
  try {
    withGlobals(
      { fetch: undefined, localStorage: createLocalStorage(), window: { addEventListener: () => {} } },
      () => {
        assert.doesNotThrow(() => {
          recordFeatureUse('files.save');
          __flushFeatureUsageForTests();
        });
      },
    );
  } finally {
    __resetFeatureUsageForTests();
  }
});

test('the client goes quiet once the server reports recording disabled', async () => {
  const calls = withStubbedFetch(
    () => okResponse({ enabled: false, recorded: 0 }),
    () => {
      recordFeatureUse('chat.send');
      __flushFeatureUsageForTests();
    },
  );
  assert.equal(calls.length, 1);

  // The latch is applied from the response promise, so let it settle before
  // asserting that further recording is dropped.
  await new Promise((resolve) => setTimeout(resolve, 0));

  recordFeatureUse('chat.send');
  assert.deepEqual([...__pendingFeatureUsesForTests()], []);
  __resetFeatureUsageForTests();
});
