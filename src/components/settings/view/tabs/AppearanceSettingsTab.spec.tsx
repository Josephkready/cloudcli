import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: vi.fn() }),
}));

const { default: AppearanceSettingsTab } = await import('./AppearanceSettingsTab');

function baseProps() {
  return {
    projectSortOrder: 'count' as const,
    onProjectSortOrderChange: vi.fn(),
    hideCliOriginChats: false,
    onHideCliOriginChatsChange: vi.fn(),
  };
}

describe('AppearanceSettingsTab', () => {
  it('renders all sections with current values', () => {
    const props = baseProps();
    render(<AppearanceSettingsTab {...props} />);
    expect(screen.getByDisplayValue('Session Count')).toBeInTheDocument();
  });

  it('has no code editor section (the editor was removed)', () => {
    render(<AppearanceSettingsTab {...baseProps()} />);
    // Only dark mode and hide-CLI-chats remain as switches.
    expect(screen.getAllByRole('switch')).toHaveLength(2);
    expect(screen.queryByText(/code editor/i)).not.toBeInTheDocument();
  });

  it('calls onProjectSortOrderChange when the sort select changes', () => {
    const props = baseProps();
    render(<AppearanceSettingsTab {...props} />);
    fireEvent.change(screen.getByDisplayValue('Session Count'), { target: { value: 'name' } });
    expect(props.onProjectSortOrderChange).toHaveBeenCalledWith('name');
  });

  it('toggles hideCliOriginChats', () => {
    const props = baseProps();
    render(<AppearanceSettingsTab {...props} />);
    const toggles = screen.getAllByRole('switch');
    // First switch is dark mode, second is hideCliOriginChats
    fireEvent.click(toggles[1]);
    expect(props.onHideCliOriginChatsChange).toHaveBeenCalledWith(true);
  });

});
