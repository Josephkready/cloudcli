import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULTS, parseBoolean, reducer } from './useUiPreferences.pure';
import type { UiPreferences, UiPreferencesAction } from './useUiPreferences.pure';

const state = (overrides: Partial<UiPreferences> = {}): UiPreferences => ({
  ...DEFAULTS,
  ...overrides,
});

describe('parseBoolean', () => {
  it('passes real booleans through', () => {
    assert.equal(parseBoolean(true, false), true);
    assert.equal(parseBoolean(false, true), false);
  });

  it('accepts the two stringified booleans localStorage can hold', () => {
    assert.equal(parseBoolean('true', false), true);
    assert.equal(parseBoolean('false', true), false);
  });

  it('falls back for anything else, including truthy junk', () => {
    for (const junk of [undefined, null, 0, 1, '', 'TRUE', 'yes', 'on', {}, []]) {
      assert.equal(parseBoolean(junk, true), true, JSON.stringify(junk) ?? 'undefined');
      assert.equal(parseBoolean(junk, false), false, JSON.stringify(junk) ?? 'undefined');
    }
  });
});

describe('reducer', () => {
  describe('set', () => {
    it('writes a changed preference into a new object', () => {
      const before = state();
      const after = reducer(before, { type: 'set', key: 'showRawParameters', value: true });
      assert.equal(after.showRawParameters, true);
      assert.notEqual(after, before);
      assert.equal(before.showRawParameters, false);
    });

    it('coerces the stringified form written by older builds', () => {
      assert.equal(reducer(state(), { type: 'set', key: 'sidebarVisible', value: 'false' }).sidebarVisible, false);
    });

    it('returns the same state when the value would not change', () => {
      const before = state({ showThinking: true });
      assert.equal(reducer(before, { type: 'set', key: 'showThinking', value: true }), before);
    });

    it('returns the same state when the value cannot be coerced', () => {
      const before = state();
      assert.equal(reducer(before, { type: 'set', key: 'voiceEnabled', value: 'maybe' }), before);
    });

    it('ignores keys that are not preferences', () => {
      const before = state();
      const action = { type: 'set', key: 'notAPreference', value: true } as unknown as UiPreferencesAction;
      const after = reducer(before, action);
      assert.equal(after, before);
      assert.equal('notAPreference' in after, false);
    });
  });

  describe('set_many', () => {
    it('applies every recognised key in one pass', () => {
      const after = reducer(state(), {
        type: 'set_many',
        value: { showRawParameters: true, sidebarVisible: 'false' },
      });
      assert.equal(after.showRawParameters, true);
      assert.equal(after.sidebarVisible, false);
      assert.equal(after.showThinking, DEFAULTS.showThinking);
    });

    it('leaves keys the payload omits alone', () => {
      const before = state({ spacesExpanded: true });
      const after = reducer(before, { type: 'set_many', value: { voiceEnabled: true } });
      assert.equal(after.spacesExpanded, true);
    });

    it('returns the same state when nothing in the payload changes anything', () => {
      const before = state({ showThinking: true });
      assert.equal(reducer(before, { type: 'set_many', value: { showThinking: true } }), before);
    });

    it('returns the same state for an empty or missing payload', () => {
      const before = state();
      assert.equal(reducer(before, { type: 'set_many', value: {} }), before);
      assert.equal(reducer(before, { type: 'set_many' }), before);
    });

    it('never writes unknown keys into state', () => {
      const before = state();
      const after = reducer(before, {
        type: 'set_many',
        value: { nope: true } as unknown as Record<string, unknown>,
      });
      assert.equal(after, before);
      assert.equal('nope' in after, false);
    });

    it('keeps the current value when a key is present but uncoercible', () => {
      const before = state({ voiceEnabled: true });
      assert.equal(reducer(before, { type: 'set_many', value: { voiceEnabled: 'huh' } }), before);
    });
  });

  describe('reset', () => {
    it('restores every default', () => {
      const before = state({ showRawParameters: true, showThinking: false, sidebarVisible: false });
      assert.deepEqual(reducer(before, { type: 'reset' }), DEFAULTS);
    });

    it('applies overrides on top of the defaults', () => {
      const after = reducer(state(), { type: 'reset', value: { sidebarVisible: false } });
      assert.equal(after.sidebarVisible, false);
      assert.equal(after.showThinking, DEFAULTS.showThinking);
    });
  });

  it('returns the same state for an unknown action', () => {
    const before = state();
    assert.equal(reducer(before, { type: 'nope' } as unknown as UiPreferencesAction), before);
  });

  it('defaults sidebar visible, thinking on, and voice off', () => {
    // Pinned because these defaults are what a first-run user sees.
    assert.deepEqual(DEFAULTS, {
      showRawParameters: false,
      showThinking: true,
      sendByCtrlEnter: false,
      sidebarVisible: true,
      spacesExpanded: false,
      voiceEnabled: false,
    });
  });
});
