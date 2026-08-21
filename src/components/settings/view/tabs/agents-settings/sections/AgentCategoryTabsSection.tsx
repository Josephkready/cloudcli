import { useTranslation } from 'react-i18next';

import { cn } from '../../../../../../lib/utils';
import { ScrollFade } from '../../../../../../shared/view/ui';
import type { AgentCategoryTabsSectionProps } from '../types';

export default function AgentCategoryTabsSection({
  categories,
  selectedCategory,
  onSelectCategory,
}: AgentCategoryTabsSectionProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="flex-shrink-0 border-b border-border">
      <ScrollFade className="px-2 md:px-4" resetKey={categories.length}>
        <div role="tablist" className="flex w-max">
          {categories.map((category) => (
            <button
              key={category}
              role="tab"
              aria-selected={selectedCategory === category}
              onClick={() => onSelectCategory(category)}
              className={cn(
                'whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium touch-manipulation transition-colors duration-fast',
                selectedCategory === category
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {category === 'account' && t('tabs.account')}
              {category === 'permissions' && t('tabs.permissions')}
              {category === 'mcp' && t('tabs.mcpServers')}
              {category === 'skills' && t('tabs.skills', {
                defaultValue: 'Skills',
              })}
            </button>
          ))}
        </div>
      </ScrollFade>
    </div>
  );
}
