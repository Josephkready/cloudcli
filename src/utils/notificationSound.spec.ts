import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// jsdom has no Web Audio implementation at all, so `window.AudioContext` is
// undefined unless a test stubs it. The module reads that global once, at
// import time, to decide whether audio is even possible — so each scenario
// (context available vs. not) needs its own fresh module instance.

class FakeGainNode {
  gain = {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
  connect = vi.fn();
}

class FakeOscillatorNode {
  type = '';
  frequency = { setValueAtTime: vi.fn() };
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeAudioContext {
  state: 'running' | 'suspended' = 'running';
  currentTime = 1.5;
  destination = {};
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  createOscillator = vi.fn(() => new FakeOscillatorNode());
  createGain = vi.fn(() => new FakeGainNode());
}

async function freshModule() {
  vi.resetModules();
  return import('./notificationSound');
}

describe('notificationSound', () => {
  const originalAudioContext = (window as unknown as { AudioContext?: unknown }).AudioContext;

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    (window as unknown as { AudioContext?: unknown }).AudioContext = originalAudioContext;
    vi.restoreAllMocks();
  });

  it('is a silent no-op when the environment has no AudioContext', async () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    const mod = await freshModule();
    await expect(mod.playNotificationSound()).resolves.toBeUndefined();
  });

  describe('with AudioContext available', () => {
    let ctxInstances: FakeAudioContext[];

    beforeEach(() => {
      ctxInstances = [];
      (window as unknown as { AudioContext: unknown }).AudioContext = vi.fn(() => {
        const ctx = new FakeAudioContext();
        ctxInstances.push(ctx);
        return ctx;
      });
    });

    it('plays two shaped tones through a lazily-created, reused AudioContext', async () => {
      const mod = await freshModule();

      await mod.playNotificationSound();
      await mod.playNotificationSound();

      // Context constructed once and reused across calls.
      expect(ctxInstances).toHaveLength(1);
      const ctx = ctxInstances[0];
      expect(ctx.createOscillator).toHaveBeenCalledTimes(4); // 2 tones x 2 calls
      expect(ctx.createGain).toHaveBeenCalledTimes(4);
    });

    it('resumes a suspended context before playing', async () => {
      const ctx = new FakeAudioContext();
      ctx.state = 'suspended';
      // The module reads window.AudioContext at import time, so the stub
      // must be in place before freshModule() re-imports it.
      (window as unknown as { AudioContext: unknown }).AudioContext = vi.fn(() => ctx);
      const mod = await freshModule();

      await mod.playNotificationSound();

      expect(ctx.resume).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when disabled via localStorage and force is not set', async () => {
      window.localStorage.setItem('notificationSoundEnabled', 'false');
      const mod = await freshModule();

      await mod.playNotificationSound();

      expect(ctxInstances).toHaveLength(0);
    });

    it('plays anyway when disabled but force=true is passed', async () => {
      window.localStorage.setItem('notificationSoundEnabled', 'false');
      const mod = await freshModule();

      await mod.playNotificationSound({ force: true });

      expect(ctxInstances).toHaveLength(1);
    });

    it('plays by default when nothing has been stored (enabled unless explicitly disabled)', async () => {
      const mod = await freshModule();
      await mod.playNotificationSound();
      expect(ctxInstances).toHaveLength(1);
    });

    it('setNotificationSoundEnabled(false) persists the disabled flag and playNotificationSound then no-ops', async () => {
      const mod = await freshModule();
      mod.setNotificationSoundEnabled(false);
      expect(window.localStorage.getItem('notificationSoundEnabled')).toBe('false');

      await mod.playNotificationSound();
      expect(ctxInstances).toHaveLength(0);
    });

    it('setNotificationSoundEnabled(true) re-enables playback', async () => {
      const mod = await freshModule();
      mod.setNotificationSoundEnabled(false);
      mod.setNotificationSoundEnabled(true);
      expect(window.localStorage.getItem('notificationSoundEnabled')).toBe('true');

      await mod.playNotificationSound();
      expect(ctxInstances).toHaveLength(1);
    });

    it('playChatCompletionSound delegates to playNotificationSound with the same options', async () => {
      const mod = await freshModule();
      window.localStorage.setItem('notificationSoundEnabled', 'false');

      await mod.playChatCompletionSound({ force: true });

      expect(ctxInstances).toHaveLength(1);
    });

    it('swallows errors thrown while playing (e.g. autoplay policy) and warns instead of rejecting', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ctx = new FakeAudioContext();
      ctx.createOscillator = vi.fn(() => {
        throw new Error('NotAllowedError');
      });
      (window as unknown as { AudioContext: unknown }).AudioContext = vi.fn(() => ctx);
      const mod = await freshModule();

      await expect(mod.playNotificationSound()).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith('Unable to play notification sound:', expect.any(Error));
    });
  });
});
