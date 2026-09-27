import { MessageSquare, Folder, GitBranch, type LucideIcon } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import type { FeatureKey } from '../../../../../shared/featureKeys';
import { Tooltip, PillBar, Pill } from '../../../../shared/view/ui';
import type { AppTab } from '../../../../types/app';
import { recordFeatureUse } from '../../../../utils/featureUsage';

type MainContentTabSwitcherProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
};

type BuiltInTab = {
  kind: 'builtin';
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
};

const BASE_TABS: BuiltInTab[] = [
  { kind: 'builtin', id: 'chat',  labelKey: 'tabs.chat',  icon: MessageSquare },
  { kind: 'builtin', id: 'files', labelKey: 'tabs.files', icon: Folder },
  { kind: 'builtin', id: 'git',   labelKey: 'tabs.git',   icon: GitBranch },
];

/** Usage keys for the built-in tabs (issue #248). */
const TAB_USAGE_KEYS: Partial<Record<AppTab, FeatureKey>> = {
  chat: 'tab.chat',
  files: 'tab.files',
  git: 'tab.git',
};

export default function MainContentTabSwitcher({
  activeTab,
  setActiveTab,
}: MainContentTabSwitcherProps) {
  const { t } = useTranslation();

  const tabs: BuiltInTab[] = [...BASE_TABS];

  return (
    <PillBar>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        const displayLabel = t(tab.labelKey);

        return (
          <Tooltip key={tab.id} content={displayLabel} position="bottom">
            <Pill
              isActive={isActive}
              onClick={() => {
                const usageKey = TAB_USAGE_KEYS[tab.id];
                if (usageKey) {
                  recordFeatureUse(usageKey);
                }
                setActiveTab(tab.id);
              }}
              className="px-2.5 py-[5px]"
            >
              <tab.icon className="h-3.5 w-3.5" strokeWidth={isActive ? 2.2 : 1.8} />
              <span className="hidden lg:inline">{displayLabel}</span>
            </Pill>
          </Tooltip>
        );
      })}
    </PillBar>
  );
}
