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
    codeEditorSettings: {
      wordWrap: true,
      showMinimap: false,
      lineNumbers: true,
      fontSize: '14',
    },
    onCodeEditorWordWrapChange: vi.fn(),
    onCodeEditorShowMinimapChange: vi.fn(),
    onCodeEditorLineNumbersChange: vi.fn(),
    onCodeEditorFontSizeChange: vi.fn(),
  };
}

describe('AppearanceSettingsTab', () => {
  it('renders all sections with current values', () => {
    const props = baseProps();
    render(<AppearanceSettingsTab {...props} />);
    expect(screen.getByDisplayValue('Session Count')).toBeInTheDocument();
    expect(screen.getByDisplayValue('14px')).toBeInTheDocument();
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

  it('toggles code editor word wrap, minimap, and line numbers', () => {
    const props = baseProps();
    render(<AppearanceSettingsTab {...props} />);
    const toggles = screen.getAllByRole('switch');
    // toggles: [dark mode, hideCli, wordWrap, showMinimap, lineNumbers]
    fireEvent.click(toggles[2]);
    expect(props.onCodeEditorWordWrapChange).toHaveBeenCalledWith(false);
    fireEvent.click(toggles[3]);
    expect(props.onCodeEditorShowMinimapChange).toHaveBeenCalledWith(true);
    fireEvent.click(toggles[4]);
    expect(props.onCodeEditorLineNumbersChange).toHaveBeenCalledWith(false);
  });

  it('changes the font size select', () => {
    const props = baseProps();
    render(<AppearanceSettingsTab {...props} />);
    fireEvent.change(screen.getByDisplayValue('14px'), { target: { value: '18' } });
    expect(props.onCodeEditorFontSizeChange).toHaveBeenCalledWith('18');
  });
});
