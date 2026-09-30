import type { ComponentType } from 'react';
import {
  Bell,
  Bot,
  Database,
  Info,
  KeyRound,
  Palette,
} from 'lucide-react';

import type {
  ProjectSortOrder,
  SettingsMainTab,
} from '../types/types';

export type SettingsMainTabMeta = {
  id: SettingsMainTab;
  label: string;
  keywords: string;
  icon: ComponentType<{ className?: string }>;
};

export const SETTINGS_MAIN_TABS: SettingsMainTabMeta[] = [
  { id: 'agents', label: 'Agents', keywords: 'agents subagents claude code', icon: Bot },
  { id: 'appearance', label: 'Appearance', keywords: 'appearance theme dark light language', icon: Palette },
  { id: 'api', label: 'API Tokens', keywords: 'api tokens auth keys', icon: KeyRound },
  { id: 'notifications', label: 'Notifications', keywords: 'notifications alerts push', icon: Bell },
  { id: 'data', label: 'Data', keywords: 'data maintenance archive cleanup declutter old conversations', icon: Database },
  { id: 'about', label: 'About', keywords: 'about version info', icon: Info },
];

// Keep in sync with `DEFAULT_PROJECT_SORT_ORDER` in
// `src/components/sidebar/utils/utils.ts` — the sidebar list and this Appearance
// settings dropdown must agree on the default order.
export const DEFAULT_PROJECT_SORT_ORDER: ProjectSortOrder = 'count';
// Keep in sync with `DEFAULT_HIDE_CLI_ORIGIN_CHATS` in
// `src/components/sidebar/utils/utils.ts` — the lists that read the preference
// and this Appearance toggle must agree on the default (#216).
export const DEFAULT_HIDE_CLI_ORIGIN_CHATS = true;
