import assert from 'node:assert/strict';
import test from 'node:test';

import type { SettingsMainTab } from '../types/types';

import { KNOWN_MAIN_TABS, normalizeMainTab } from './settingsTabs';

// An independent enumeration of the full SettingsMainTab union. Typed as
// Record<SettingsMainTab, true>, so adding a member to the union without adding
// it here is a compile error (`npm run typecheck` covers test files). That
// keeps the exhaustiveness check below honest: it can't silently miss a tab.
const ALL_MAIN_TABS: Record<SettingsMainTab, true> = {
  agents: true,
  appearance: true,
  git: true,
  api: true,
  voice: true,
  tasks: true,
  notifications: true,
  about: true,
};

const everyTab = Object.keys(ALL_MAIN_TABS) as SettingsMainTab[];
const knownTabs = KNOWN_MAIN_TABS as readonly SettingsMainTab[];

test('KNOWN_MAIN_TABS lists every SettingsMainTab (no tab silently drops out) — #112', () => {
  for (const tab of everyTab) {
    assert.ok(
      knownTabs.includes(tab),
      `${tab} is missing from KNOWN_MAIN_TABS — deep-linking to it would fall back to 'agents'`,
    );
  }
});

test('every known tab normalizes to itself', () => {
  for (const tab of everyTab) {
    assert.equal(normalizeMainTab(tab), tab);
  }
});

test("'voice' normalizes to 'voice' (regression for #112)", () => {
  assert.equal(normalizeMainTab('voice'), 'voice');
});

test("unknown tabs fall back to 'agents'", () => {
  assert.equal(normalizeMainTab('does-not-exist'), 'agents');
  assert.equal(normalizeMainTab(''), 'agents');
});

test("legacy 'tools' tab maps to 'agents'", () => {
  assert.equal(normalizeMainTab('tools'), 'agents');
});
