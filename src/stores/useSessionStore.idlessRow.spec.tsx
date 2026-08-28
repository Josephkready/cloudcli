import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from './useSessionStore';
import type { NormalizedMessage } from './useSessionStore';

/**
 * #450 / #389 — the durability half.
 *
 * `appendRealtime` assigns `slot.realtimeMessages` BEFORE it recomputes the
 * merge, so a row that makes the merge throw is already in the slot when it
 * does — and it never leaves. `slot.merged` froze, `notify` stopped firing, and
 * every subsequent append or refresh for that session threw on the same row
 * (`refreshFromServer` swallows the error, so it just looked like the chat had
 * stopped updating). One `chat_resumed` frame — one click of the Resume banner
 * — was enough, because gateway frames carry no `id`.
 *
 * The contract these tests pin is not just "does not throw". It is that the
 * session is still ALIVE afterwards: a later, perfectly valid message still
 * arrives, still merges, and still reaches subscribers.
 */

const mockFetch = vi.fn();
vi.mock('../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => mockFetch(...args),
}));

const SESSION = 'session-poisoned';

const serverMessage = (id: string, content: string, offsetMs: number): NormalizedMessage => ({
  id,
  sessionId: SESSION,
  kind: 'text',
  role: 'user',
  content,
  provider: 'claude',
  timestamp: new Date(1_700_000_000_000 + offsetMs).toISOString(),
} as NormalizedMessage);

const liveAssistant = (id: string, content: string, offsetMs: number): NormalizedMessage => ({
  id,
  sessionId: SESSION,
  kind: 'text',
  role: 'assistant',
  content,
  provider: 'claude',
  timestamp: new Date(1_700_000_000_000 + offsetMs).toISOString(),
} as NormalizedMessage);

/** Verbatim shape of the frame emitted at chat-websocket.service.ts:581/:656. */
const chatResumedFrame = (): NormalizedMessage => ({
  kind: 'chat_resumed',
  sessionId: SESSION,
  resumed: 1,
  timestamp: new Date(1_700_000_001_000).toISOString(),
} as unknown as NormalizedMessage);

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => ({ data: body }) };
}

/**
 * A store with a real server transcript loaded. The transcript matters: with no
 * server rows `computeMerged` returns early and never dereferences an id, so an
 * empty session hid the bug.
 */
async function setupLoadedStore() {
  const rendered = renderHook(() => useSessionStore());
  mockFetch.mockResolvedValueOnce(
    jsonResponse({
      messages: [serverMessage('m1', 'first', 0), serverMessage('m2', 'second', 1000)],
      total: 2,
      hasMore: false,
    }),
  );
  await act(async () => {
    await rendered.result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
  });
  expect(rendered.result.current.getSlot(SESSION).serverMessages).toHaveLength(2);
  return rendered;
}

const mergedIds = (rendered: Awaited<ReturnType<typeof setupLoadedStore>>): unknown[] =>
  rendered.result.current.getSlot(SESSION).merged.map((m) => m.id);

beforeEach(() => {
  mockFetch.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('appendRealtime with an id-less row (#450)', () => {
  it('does not throw', async () => {
    const rendered = await setupLoadedStore();
    expect(() => {
      act(() => {
        rendered.result.current.appendRealtime(SESSION, chatResumedFrame());
      });
    }).not.toThrow();
  });

  it('does not let the row into the slot', async () => {
    const rendered = await setupLoadedStore();
    act(() => {
      rendered.result.current.appendRealtime(SESSION, chatResumedFrame());
    });

    // Rejected at the door, so it can never participate in a later merge.
    expect(rendered.result.current.getSlot(SESSION).realtimeMessages).toHaveLength(0);
  });

  it('leaves the existing transcript intact', async () => {
    const rendered = await setupLoadedStore();
    act(() => {
      rendered.result.current.appendRealtime(SESSION, chatResumedFrame());
    });

    expect(mergedIds(rendered)).toEqual(['m1', 'm2']);
  });

  it('says so, rather than dropping the frame in silence', async () => {
    const rendered = await setupLoadedStore();
    act(() => {
      rendered.result.current.appendRealtime(SESSION, chatResumedFrame());
    });

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('no id'),
      expect.objectContaining({ sessionId: SESSION, kind: 'chat_resumed' }),
    );
  });

  /* ---- the durability half: is the session still usable afterwards? ---- */

  it('still accepts the NEXT valid message', async () => {
    const rendered = await setupLoadedStore();

    act(() => {
      rendered.result.current.appendRealtime(SESSION, chatResumedFrame());
    });
    act(() => {
      rendered.result.current.appendRealtime(SESSION, liveAssistant('live1', 'a reply', 2000));
    });

    // Before the fix this second append threw on the poison row still sitting
    // in `realtimeMessages`, and the reply never reached the transcript.
    expect(mergedIds(rendered)).toEqual(['m1', 'm2', 'live1']);
  });

  it('still produces a fresh merged array after the bad frame', async () => {
    const rendered = await setupLoadedStore();

    act(() => {
      rendered.result.current.appendRealtime(SESSION, chatResumedFrame());
    });

    const before = rendered.result.current.getSlot(SESSION).merged;
    act(() => {
      rendered.result.current.appendRealtime(SESSION, liveAssistant('live1', 'a reply', 2000));
    });
    const after = rendered.result.current.getSlot(SESSION).merged;

    // A frozen slot keeps handing back the same array identity — that is what
    // "the chat stopped updating" looked like from the UI's side.
    expect(after).not.toBe(before);
  });

  it('still refreshes from the server after the bad frame', async () => {
    const rendered = await setupLoadedStore();
    act(() => {
      rendered.result.current.appendRealtime(SESSION, chatResumedFrame());
    });

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        messages: [
          serverMessage('m1', 'first', 0),
          serverMessage('m2', 'second', 1000),
          serverMessage('m3', 'third', 2000),
        ],
        total: 3,
        hasMore: false,
      }),
    );
    await act(async () => {
      await rendered.result.current.refreshFromServer(SESSION);
    });

    // `refreshFromServer` swallows its own errors, so a wedged slot showed up
    // only as a transcript that silently stopped growing.
    expect(mergedIds(rendered)).toEqual(['m1', 'm2', 'm3']);
  });

  it('survives a null or undefined row without throwing', async () => {
    const rendered = await setupLoadedStore();

    // The guard uses optional chaining, but the hook-level wiring deserves its
    // own case: a `JSON.parse` result is not guaranteed to be an object.
    expect(() => {
      act(() => {
        rendered.result.current.appendRealtime(SESSION, null as unknown as NormalizedMessage);
        rendered.result.current.appendRealtime(SESSION, undefined as unknown as NormalizedMessage);
      });
    }).not.toThrow();

    expect(rendered.result.current.getSlot(SESSION).realtimeMessages).toHaveLength(0);
    expect(mergedIds(rendered)).toEqual(['m1', 'm2']);

    // And the session is still usable.
    act(() => {
      rendered.result.current.appendRealtime(SESSION, liveAssistant('live1', 'after null', 2000));
    });
    expect(mergedIds(rendered)).toEqual(['m1', 'm2', 'live1']);
  });

  it('survives several bad frames in a row', async () => {
    const rendered = await setupLoadedStore();
    act(() => {
      rendered.result.current.appendRealtime(SESSION, chatResumedFrame());
      rendered.result.current.appendRealtime(SESSION, chatResumedFrame());
      rendered.result.current.appendRealtime(SESSION, chatResumedFrame());
    });
    act(() => {
      rendered.result.current.appendRealtime(SESSION, liveAssistant('live1', 'still here', 2000));
    });

    expect(mergedIds(rendered)).toEqual(['m1', 'm2', 'live1']);
  });
});

describe('appendRealtimeBatch with an id-less row (#450)', () => {
  it('drops only the bad row and keeps the rest of the batch', async () => {
    const rendered = await setupLoadedStore();

    act(() => {
      rendered.result.current.appendRealtimeBatch(SESSION, [
        liveAssistant('live1', 'one', 2000),
        chatResumedFrame(),
        liveAssistant('live2', 'two', 3000),
      ]);
    });

    // A single bad row must not cost the batch its real messages — that would
    // be a worse bug than the crash it replaces.
    expect(mergedIds(rendered)).toEqual(['m1', 'm2', 'live1', 'live2']);
  });

  it('survives a null entry inside a batch', async () => {
    const rendered = await setupLoadedStore();

    expect(() => {
      act(() => {
        rendered.result.current.appendRealtimeBatch(SESSION, [
          liveAssistant('live1', 'one', 2000),
          null as unknown as NormalizedMessage,
          liveAssistant('live2', 'two', 3000),
        ]);
      });
    }).not.toThrow();

    expect(mergedIds(rendered)).toEqual(['m1', 'm2', 'live1', 'live2']);
  });

  it('leaves the session usable when the whole batch is bad', async () => {
    const rendered = await setupLoadedStore();

    act(() => {
      rendered.result.current.appendRealtimeBatch(SESSION, [chatResumedFrame()]);
    });
    act(() => {
      rendered.result.current.appendRealtime(SESSION, liveAssistant('live1', 'later', 2000));
    });

    expect(mergedIds(rendered)).toEqual(['m1', 'm2', 'live1']);
  });
});
