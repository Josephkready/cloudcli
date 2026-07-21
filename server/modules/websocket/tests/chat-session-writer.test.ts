import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import type { NormalizedMessage, RealtimeClientConnection } from '@/shared/types.js';

/**
 * Direct unit coverage for the gateway writer (issue #105). Everywhere else it
 * is exercised only transitively through the registry, which hides its own
 * branches: the non-normalized drop, the `session_created` swallow, provider-id
 * idempotency, and the `readyState` gate on `forward`.
 *
 * The writer talks to the rest of the system purely through callbacks, so these
 * tests need no database and no registry — just a fake socket and spies.
 */

/** Minimal stand-in for a websocket connection. */
class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

type Harness = {
  writer: ChatSessionWriter;
  connection: FakeConnection;
  providerIds: string[];
  blockedChanges: boolean[];
  decorated: NormalizedMessage[];
};

/**
 * Builds a writer whose `decorateOutboundEvent` mimics the registry: it stamps a
 * monotonic `seq`, remaps `sessionId` to the app id, and can be told to drop an
 * event (returning `null`) the way the registry drops a duplicate `complete`.
 */
function makeWriter(options: {
  providerSessionId?: string | null;
  dropEvents?: boolean;
  isRunActive?: () => boolean;
  withBlockedCallback?: boolean;
} = {}): Harness {
  const connection = new FakeConnection();
  const providerIds: string[] = [];
  const blockedChanges: boolean[] = [];
  const decorated: NormalizedMessage[] = [];
  let seq = 0;

  const writer = new ChatSessionWriter({
    connection: connection as unknown as RealtimeClientConnection,
    userId: 'user-1',
    provider: 'claude',
    providerSessionId: options.providerSessionId ?? null,
    onProviderSessionId: (providerSessionId) => {
      providerIds.push(providerSessionId);
    },
    onBlockedChange: options.withBlockedCallback === false
      ? undefined
      : (blocked) => {
        blockedChanges.push(blocked);
      },
    isRunActive: options.isRunActive,
    decorateOutboundEvent: (message) => {
      decorated.push(message);
      if (options.dropEvents) {
        return null;
      }
      seq += 1;
      return { ...message, sessionId: 'app-session', seq };
    },
  });

  return { writer, connection, providerIds, blockedChanges, decorated };
}

test('non-normalized payloads are dropped instead of leaking to the client', () => {
  const { writer, connection, decorated } = makeWriter();

  // Every shape a buggy runtime could hand the writer: non-objects, and objects
  // without the `kind` discriminator the protocol is built on.
  writer.send(null);
  writer.send(undefined);
  writer.send('a raw string');
  writer.send(42);
  writer.send([{ kind: 'assistant' }]);
  writer.send({ text: 'no kind field' });
  writer.send({ kind: 123 });

  assert.equal(decorated.length, 0, 'nothing reaches the registry decorator');
  assert.equal(connection.frames.length, 0, 'nothing reaches the client');
});

test('session_created is swallowed and captured as the provider-id mapping', () => {
  const { writer, connection, providerIds, decorated } = makeWriter();

  writer.send({ kind: 'session_created', provider: 'claude', newSessionId: 'native-1' });

  assert.deepEqual(providerIds, ['native-1'], 'the announced id is reported to the registry');
  assert.equal(writer.getSessionId(), 'native-1', 'runtimes read back the provider-native id');
  assert.equal(decorated.length, 0, 'session_created never reaches the event log');
  assert.equal(connection.frames.length, 0, 'the frontend never learns provider-native ids');
});

test('session_created falls back to sessionId when no newSessionId is announced', () => {
  const { writer, providerIds } = makeWriter();

  writer.send({ kind: 'session_created', provider: 'claude', sessionId: 'native-fallback' });
  assert.deepEqual(providerIds, ['native-fallback']);

  // A session_created with neither id is swallowed without a bogus mapping.
  const bare = makeWriter();
  bare.writer.send({ kind: 'session_created', provider: 'claude' });
  assert.deepEqual(bare.providerIds, []);
  assert.equal(bare.writer.getSessionId(), null);
});

test('provider-id capture is idempotent across setSessionId and session_created', () => {
  const { writer, providerIds } = makeWriter();

  writer.setSessionId('native-1');
  writer.setSessionId('native-1');
  writer.send({ kind: 'session_created', provider: 'claude', newSessionId: 'native-1' });

  assert.deepEqual(providerIds, ['native-1'], 'the same id is reported exactly once');

  // A genuinely different id (a runtime that started a fresh transcript) is a
  // real change and must be propagated.
  writer.setSessionId('native-2');
  assert.deepEqual(providerIds, ['native-1', 'native-2']);
  assert.equal(writer.getSessionId(), 'native-2');

  // Empty ids are ignored rather than clearing a known mapping.
  writer.setSessionId('');
  assert.deepEqual(providerIds, ['native-1', 'native-2']);
  assert.equal(writer.getSessionId(), 'native-2');
});

test('a writer constructed with a resumed provider id does not re-announce it', () => {
  const { writer, providerIds } = makeWriter({ providerSessionId: 'resumed-native' });

  assert.equal(writer.getSessionId(), 'resumed-native');
  writer.setSessionId('resumed-native');
  assert.deepEqual(providerIds, [], 'no redundant mapping write on resume');
});

test('normal events are decorated then forwarded to the client', () => {
  const { writer, connection, decorated } = makeWriter();

  writer.send({ kind: 'assistant', provider: 'claude', sessionId: 'native-1', content: 'hi' });
  writer.send({ kind: 'tool_use', provider: 'claude', sessionId: 'native-1' });

  assert.deepEqual(decorated.map((event) => event.kind), ['assistant', 'tool_use']);
  assert.deepEqual(
    connection.frames.map((frame) => [frame.kind, frame.sessionId, frame.seq]),
    [['assistant', 'app-session', 1], ['tool_use', 'app-session', 2]],
  );
});

test('an event the registry drops is never forwarded', () => {
  const { writer, connection, decorated } = makeWriter({ dropEvents: true });

  writer.send({ kind: 'complete', provider: 'claude', exitCode: 0 });

  assert.equal(decorated.length, 1, 'the decorator still saw it');
  assert.equal(connection.frames.length, 0, 'but the client did not');
});

test('forward is gated on readyState: a closed socket drops frames without throwing', () => {
  const { writer, connection, decorated } = makeWriter();

  writer.send({ kind: 'assistant', provider: 'claude', content: 'delivered' });
  assert.equal(connection.frames.length, 1);

  // CLOSING / CLOSED / CONNECTING are all "not open".
  for (const readyState of [0, 2, 3]) {
    connection.readyState = readyState;
    writer.send({ kind: 'assistant', provider: 'claude', content: 'dropped' });
  }
  assert.equal(connection.frames.length, 1, 'nothing is written to a non-open socket');
  assert.equal(decorated.length, 4, 'events are still sequenced/buffered for later replay');

  // Re-opening (or re-attaching a new socket) resumes delivery.
  connection.readyState = 1;
  writer.send({ kind: 'assistant', provider: 'claude', content: 'delivered again' });
  assert.equal(connection.frames.length, 2);
});

test('updateWebSocket redirects subsequent frames to the new connection', () => {
  const { writer, connection } = makeWriter();
  const replacement = new FakeConnection();

  writer.send({ kind: 'assistant', provider: 'claude', content: 'first' });
  writer.updateWebSocket(replacement as unknown as RealtimeClientConnection);
  writer.send({ kind: 'assistant', provider: 'claude', content: 'second' });

  assert.equal(connection.frames.length, 1, 'the original socket keeps only its earlier frame');
  assert.equal(replacement.frames.length, 1);
  assert.equal(replacement.frames[0]?.seq, 2, 'sequencing continues across the reattach');
});

test('sendComplete synthesizes a terminal complete carrying the provider-native id', () => {
  const { writer, connection, decorated } = makeWriter();
  writer.setSessionId('native-1');

  writer.sendComplete({ exitCode: 1, aborted: true });

  const raw = decorated[0];
  assert.equal(raw?.kind, 'complete');
  assert.equal(raw?.provider, 'claude');
  assert.equal(raw?.sessionId, 'native-1', 'the registry receives the provider-native id to remap');
  assert.equal(raw?.exitCode, 1);
  assert.equal(raw?.aborted, true);
  assert.equal(raw?.success, false);

  // Forwarded to the client with the app id the decorator stamped on.
  assert.equal(connection.frames[0]?.kind, 'complete');
  assert.equal(connection.frames[0]?.sessionId, 'app-session');
});

test('sendComplete on a dropped duplicate does not reach the client', () => {
  const { writer, connection } = makeWriter({ dropEvents: true });

  writer.sendComplete({ exitCode: 0 });
  assert.equal(connection.frames.length, 0);
});

test('setBlocked forwards to onBlockedChange and tolerates a missing callback', () => {
  const { writer, blockedChanges } = makeWriter();

  writer.setBlocked(true);
  writer.setBlocked(false);
  assert.deepEqual(blockedChanges, [true, false]);

  const withoutCallback = makeWriter({ withBlockedCallback: false });
  assert.doesNotThrow(() => withoutCallback.writer.setBlocked(true));
});

test('isRunActive defaults to true and otherwise mirrors the host status source', () => {
  const withoutSource = makeWriter();
  assert.equal(withoutSource.writer.isRunActive(), true, 'providers only bail when told to');

  let active = true;
  const withSource = makeWriter({ isRunActive: () => active });
  assert.equal(withSource.writer.isRunActive(), true);
  active = false;
  assert.equal(withSource.writer.isRunActive(), false);
});

test('the writer stays a drop-in replacement for WebSocketWriter', () => {
  const { writer, connection } = makeWriter();

  assert.equal(writer.isWebSocketWriter, true, 'runtimes feature-detect on this flag');
  assert.equal(writer.userId, 'user-1');
  assert.equal(writer.ws, connection as unknown as RealtimeClientConnection);
});
