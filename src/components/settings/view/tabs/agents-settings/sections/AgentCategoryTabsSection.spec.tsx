import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { AgentCategory } from '../../../../types/types';

import AgentCategoryTabsSection from './AgentCategoryTabsSection';

describe('AgentCategoryTabsSection', () => {
  it('renders a tab for each category and marks the selected one', () => {
    const categories: AgentCategory[] = ['account', 'permissions', 'mcp'];

    render(
      <AgentCategoryTabsSection
        categories={categories}
        selectedCategory="permissions"
        selectedAgent="claude"
        onSelectCategory={vi.fn()}
      />,
    );

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);

    const selected = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
    expect(selected?.textContent).toMatch(/permissions/i);
  });

  it('calls onSelectCategory when a tab is clicked', async () => {
    const user = userEvent.setup();
    const onSelectCategory = vi.fn();
    const categories: AgentCategory[] = ['account', 'mcp'];

    render(
      <AgentCategoryTabsSection
        categories={categories}
        selectedCategory="account"
        selectedAgent="claude"
        onSelectCategory={onSelectCategory}
      />,
    );

    await user.click(screen.getByRole('tab', { name: /mcp servers/i }));
    expect(onSelectCategory).toHaveBeenCalledWith('mcp');
  });
});
