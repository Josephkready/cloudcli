import { describe, it, expect, vi, afterEach } from 'vitest';

// jsdom has no real audio decoding/playback pipeline, so HTMLAudioElement is
// stubbed here: `play()`/`pause()`/`load()` exist but do nothing on their own,
// and `ended`/`error` only fire when the test dispatches them explicitly.
class FakeAudio {
  src = '';
  paused = true;
  listeners: Record<string, Array<() => void>> = {};
  play = vi.fn(() => {
    this.paused = false;
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  load = vi.fn();
  addEventListener(event: string, cb: () => void) {
    (this.listeners[event] ??= []).push(cb);
  }
  removeEventListener() {}
  dispatchTest(event: string) {
    (this.listeners[event] ?? []).forEach((cb) => cb());
  }
}

let currentAudio: FakeAudio;

// Drains the microtask queue enough times for a chain of resolved promises
// (synthesizeVoice -> .finally -> res.blob() -> audio.play()) to settle,
// without depending on real timers/wall-clock waits.
async function flushMicrotasks(times = 10) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

// `voicePlayer` is a module-level singleton that lazily caches its
// `HTMLAudioElement` the first time it's used, so tests can't share one
// import across the file (a later test would silently reuse the first
// test's cached fake Audio). Each test resets the module registry and
// re-imports both voicePlayer and voiceApi fresh, then wires the Audio stub
// before anything in the module can call `new Audio()`.
async function freshModules() {
  currentAudio = new FakeAudio();
  vi.stubGlobal(
    'Audio',
    vi.fn(() => currentAudio),
  );
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:mock-${Math.random()}`),
    revokeObjectURL: vi.fn(),
  });
  vi.resetModules();
  const voiceApi = await import('./voiceApi');
  const { voicePlayer, voiceId } = await import('./voicePlayer');
  return { voiceApi, voicePlayer, voiceId };
}

describe('voicePlayer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('voiceId', () => {
    it('is deterministic for the same content and signature', async () => {
      const { voiceId } = await freshModules();
      const a = voiceId('hello', 'sig-a');
      const b = voiceId('hello', 'sig-a');
      expect(a).toBe(b);
    });

    it('differs when content or signature differ', async () => {
      const { voiceId } = await freshModules();
      const base = voiceId('hello', 'sig-a');
      expect(voiceId('world', 'sig-a')).not.toBe(base);
      expect(voiceId('hello', 'sig-b')).not.toBe(base);
    });
  });

  describe('unlock', () => {
    it('primes the audio element by playing then pausing it once play() resolves, only once', async () => {
      const { voicePlayer } = await freshModules();
      voicePlayer.unlock();
      expect(currentAudio.play).toHaveBeenCalledTimes(1);

      // pause() only happens once the play() promise resolves.
      await Promise.resolve();
      await Promise.resolve();
      expect(currentAudio.pause).toHaveBeenCalledTimes(1);

      voicePlayer.unlock();
      // Second call is a no-op since already unlocked; no new Audio() constructed.
      expect(currentAudio.play).toHaveBeenCalledTimes(1);
    });

    it('swallows a synchronous throw from audio.play() during priming and stays locked', async () => {
      const { voicePlayer } = await freshModules();
      currentAudio.play = vi.fn(() => {
        throw new Error('NotAllowedError');
      });

      expect(() => voicePlayer.unlock()).not.toThrow();
      expect(currentAudio.pause).not.toHaveBeenCalled();

      // Since priming failed, a later unlock() call should retry rather than
      // treat us as already unlocked.
      currentAudio.play = vi.fn(() => {
        currentAudio.paused = false;
        return Promise.resolve();
      });
      voicePlayer.unlock();
      expect(currentAudio.play).toHaveBeenCalledTimes(1);
    });

    it('does not mark itself unlocked when audio.play() returns a rejected promise', async () => {
      const { voicePlayer } = await freshModules();
      currentAudio.play = vi.fn(() => Promise.reject(new Error('NotAllowedError')));

      voicePlayer.unlock();
      await Promise.resolve();
      await Promise.resolve();

      expect(currentAudio.pause).not.toHaveBeenCalled();

      // Still locked, so a later unlock() call retries instead of being a no-op.
      currentAudio.play = vi.fn(() => {
        currentAudio.paused = false;
        return Promise.resolve();
      });
      voicePlayer.unlock();
      expect(currentAudio.play).toHaveBeenCalledTimes(1);
    });
  });

  describe('getSnapshot', () => {
    it('returns the shared idle snapshot object when nothing is happening for this id', async () => {
      const { voicePlayer } = await freshModules();
      const snap = voicePlayer.getSnapshot('some-id');
      expect(snap).toEqual({ state: 'idle', error: null });
    });
  });

  describe('subscribe', () => {
    it('notifies subscribers on state changes and stops after unsubscribing', async () => {
      const { voiceApi, voicePlayer, voiceId } = await freshModules();
      const fakeBlob = new Blob(['audio-data']);
      vi.spyOn(voiceApi, 'synthesizeVoice').mockResolvedValue({ ok: true, blob: async () => fakeBlob } as Response);

      const listener = vi.fn();
      const unsubscribe = voicePlayer.subscribe(listener);

      const content = 'notify me';
      const id = voiceId(content);
      voicePlayer.toggle(content);
      expect(listener).toHaveBeenCalled();

      await vi.waitFor(() => expect(voicePlayer.getSnapshot(id).state).toBe('playing'));
      const callsWhilePlaying = listener.mock.calls.length;

      unsubscribe();
      voicePlayer.stop();
      expect(listener.mock.calls.length).toBe(callsWhilePlaying);
    });
  });

  describe('play / toggle happy path', () => {
    it('goes loading -> playing and sets audio.src from the synthesized blob', async () => {
      const { voiceApi, voicePlayer, voiceId } = await freshModules();
      const fakeBlob = new Blob(['audio-data'], { type: 'audio/mpeg' });
      const okResponse = { ok: true, blob: async () => fakeBlob } as Response;
      vi.spyOn(voiceApi, 'synthesizeVoice').mockResolvedValue(okResponse);

      const id = voiceId('read this out loud');
      voicePlayer.toggle('read this out loud');

      // Immediately after toggle: loading.
      expect(voicePlayer.getSnapshot(id).state).toBe('loading');

      // Flush the microtask queue for the async play() body.
      await vi.waitFor(() => expect(voicePlayer.getSnapshot(id).state).toBe('playing'));
      expect(currentAudio.src).toMatch(/^blob:mock-/);
      expect(currentAudio.play).toHaveBeenCalled();
    });

    it('reuses the cached blob URL on a second play of the same content (no second fetch)', async () => {
      const { voiceApi, voicePlayer, voiceId } = await freshModules();
      const fakeBlob = new Blob(['audio-data']);
      const synth = vi.spyOn(voiceApi, 'synthesizeVoice').mockResolvedValue({ ok: true, blob: async () => fakeBlob } as Response);

      const content = 'cache me';
      const id = voiceId(content);
      voicePlayer.toggle(content);
      await vi.waitFor(() => expect(voicePlayer.getSnapshot(id).state).toBe('playing'));
      expect(synth).toHaveBeenCalledTimes(1);

      voicePlayer.stop();
      voicePlayer.toggle(content);
      await vi.waitFor(() => expect(voicePlayer.getSnapshot(id).state).toBe('playing'));

      // Still only called once — second play served from cache.
      expect(synth).toHaveBeenCalledTimes(1);
    });

    it('toggle called twice on the same content while playing stops playback instead of replaying', async () => {
      const { voiceApi, voicePlayer, voiceId } = await freshModules();
      const fakeBlob = new Blob(['audio-data']);
      vi.spyOn(voiceApi, 'synthesizeVoice').mockResolvedValue({ ok: true, blob: async () => fakeBlob } as Response);

      const content = 'toggle me';
      const id = voiceId(content);
      voicePlayer.toggle(content);
      await vi.waitFor(() => expect(voicePlayer.getSnapshot(id).state).toBe('playing'));

      voicePlayer.toggle(content);
      expect(voicePlayer.getSnapshot(id).state).toBe('idle');
      expect(currentAudio.pause).toHaveBeenCalled();
    });

    it('onEnded transitions playing audio back to idle', async () => {
      const { voiceApi, voicePlayer, voiceId } = await freshModules();
      const fakeBlob = new Blob(['audio-data']);
      vi.spyOn(voiceApi, 'synthesizeVoice').mockResolvedValue({ ok: true, blob: async () => fakeBlob } as Response);

      const content = 'ends naturally';
      const id = voiceId(content);
      voicePlayer.toggle(content);
      await vi.waitFor(() => expect(voicePlayer.getSnapshot(id).state).toBe('playing'));

      currentAudio.dispatchTest('ended');
      expect(voicePlayer.getSnapshot(id).state).toBe('idle');
    });

    it('an error event while playing also resets to idle', async () => {
      const { voiceApi, voicePlayer, voiceId } = await freshModules();
      const fakeBlob = new Blob(['audio-data']);
      vi.spyOn(voiceApi, 'synthesizeVoice').mockResolvedValue({ ok: true, blob: async () => fakeBlob } as Response);

      const content = 'errors mid playback';
      const id = voiceId(content);
      voicePlayer.toggle(content);
      await vi.waitFor(() => expect(voicePlayer.getSnapshot(id).state).toBe('playing'));

      currentAudio.dispatchTest('error');
      expect(voicePlayer.getSnapshot(id).state).toBe('idle');
    });
  });

  describe('error handling', () => {
    it('surfaces the server-provided error message on a non-ok response, then clears it after 6s', async () => {
      const { voiceApi, voicePlayer, voiceId } = await freshModules();
      vi.useFakeTimers();
      vi.spyOn(voiceApi, 'synthesizeVoice').mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: 'synthesis exploded' }),
      } as unknown as Response);

      const content = 'boom';
      const id = voiceId(content);
      voicePlayer.toggle(content);

      await vi.advanceTimersByTimeAsync(0);

      const snap = voicePlayer.getSnapshot(id);
      expect(snap.state).toBe('idle');
      expect(snap.error).toBe('synthesis exploded');

      await vi.advanceTimersByTimeAsync(6000);
      expect(voicePlayer.getSnapshot(id).error).toBeNull();
    });

    it('falls back to a generic status message when the error body is not JSON', async () => {
      const { voiceApi, voicePlayer, voiceId } = await freshModules();
      vi.useFakeTimers();
      vi.spyOn(voiceApi, 'synthesizeVoice').mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => {
          throw new Error('not json');
        },
      } as unknown as Response);

      const content = 'bad body';
      const id = voiceId(content);
      voicePlayer.toggle(content);
      await vi.advanceTimersByTimeAsync(0);

      expect(voicePlayer.getSnapshot(id).error).toBe('Read-aloud failed (503)');
    });

    it('reports a timeout message when the fetch is aborted', async () => {
      const { voiceApi, voicePlayer, voiceId } = await freshModules();
      vi.useFakeTimers();
      vi.spyOn(voiceApi, 'synthesizeVoice').mockImplementation((_text, signal) => {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

      const content = 'takes too long';
      const id = voiceId(content);
      voicePlayer.toggle(content);

      await vi.advanceTimersByTimeAsync(330000);

      expect(voicePlayer.getSnapshot(id).error).toBe('Read-aloud timed out.');
    });
  });

  describe('cache eviction', () => {
    it('evicts and revokes the oldest cached blob URL once the cache exceeds 24 entries', async () => {
      const { voiceApi, voicePlayer, voiceId } = await freshModules();
      vi.spyOn(voiceApi, 'synthesizeVoice').mockImplementation(async () => ({
        ok: true,
        blob: async () => new Blob(['audio-data']),
      }) as unknown as Response);

      // Play 25 distinct pieces of content sequentially so the LRU cache
      // (capped at 24) evicts the very first one. All promises involved
      // (synthesizeVoice, blob(), audio.play()) resolve immediately with no
      // real timers, so a fixed number of microtask flushes deterministically
      // drives each play to completion instead of polling with vi.waitFor.
      for (let i = 0; i < 25; i++) {
        const content = `clip number ${i}`;
        voicePlayer.toggle(content);
        const id = voiceId(content);
        await flushMicrotasks();
        expect(voicePlayer.getSnapshot(id).state).toBe('playing');
        voicePlayer.stop();
      }

      // The 25th distinct URL created should have triggered exactly one
      // revocation (of the oldest, now-evicted entry).
      expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop', () => {
    it('aborts an in-flight request and returns to idle without setting an error', async () => {
      const { voiceApi, voicePlayer, voiceId } = await freshModules();
      vi.spyOn(voiceApi, 'synthesizeVoice').mockImplementation((_text, signal) => {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

      const content = 'stop me mid flight';
      const id = voiceId(content);
      voicePlayer.toggle(content);
      expect(voicePlayer.getSnapshot(id).state).toBe('loading');

      voicePlayer.stop();
      await Promise.resolve();
      await Promise.resolve();

      expect(voicePlayer.getSnapshot(id)).toEqual({ state: 'idle', error: null });
    });
  });
});
