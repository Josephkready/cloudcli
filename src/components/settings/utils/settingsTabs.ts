import type { SettingsMainTab } from '../types/types';

// Every SettingsMainTab that deep-linking or initial-tab seeding may request.
// This list must contain every member of the SettingsMainTab union:
// normalizeMainTab() falls back to 'agents' for anything not listed here, so a
// tab that is missing is silently unreachable via a deep-link (that was the
// #112 'voice' bug). The `satisfies` clause turns a typo into a compile error;
// settingsTabs.test.ts enforces that the list stays exhaustive.
export const KNOWN_MAIN_TABS = [
  'agents',
  'appearance',
  'git',
  'api',
  'voice',
  'notifications',
  'about',
] as const satisfies readonly SettingsMainTab[];

export const normalizeMainTab = (tab: string): SettingsMainTab => {
  // Keep backwards compatibility with older callers that still pass "tools".
  if (tab === 'tools') {
    return 'agents';
  }

  return (KNOWN_MAIN_TABS as readonly SettingsMainTab[]).includes(tab as SettingsMainTab)
    ? (tab as SettingsMainTab)
    : 'agents';
};
