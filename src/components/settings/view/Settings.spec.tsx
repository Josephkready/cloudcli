import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const controller = vi.hoisted(() => ({
  activeTab: 'agents',
  setActiveTab: vi.fn(),
  saveStatus: null,
  projectSortOrder: 'date',
  setProjectSortOrder: vi.fn(),
  hideCliOriginChats: true,
  setHideCliOriginChats: vi.fn(),
  codeEditorSettings: {
    wordWrap: true,
    showMinimap: true,
    lineNumbers: true,
    fontSize: '14',
  },
  updateCodeEditorSetting: vi.fn(),
  claudePermissions: { allowedTools: [], disallowedTools: [], skipPermissions: false },
  setClaudePermissions: vi.fn(),
  notificationPreferences: {
    channels: { inApp: true, webPush: false, sound: true },
    events: { actionRequired: true, stop: true, error: true },
  },
  setNotificationPreferences: vi.fn(),
  codexPermissionMode: 'default',
  setCodexPermissionMode: vi.fn(),
  providerAuthStatus: {
    claude: { authenticated: false },
    codex: { authenticated: false },
    cursor: { authenticated: false },
  },
  openLoginForProvider: vi.fn(),
  showLoginModal: false,
  setShowLoginModal: vi.fn(),
  loginProvider: null,
  handleLoginComplete: vi.fn(),
}));

vi.mock('../hooks/useSettingsController', () => ({
  useSettingsController: () => controller,
}));

vi.mock('../../../hooks/useWebPush', () => ({
  useWebPush: () => ({
    permission: 'default',
    isSubscribed: false,
    isLoading: false,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

vi.mock('../../provider-auth/view/ProviderLoginModal', () => ({ default: () => null }));
vi.mock('./SettingsSidebar', () => ({
  default: () => <button type="button">Sidebar control</button>,
}));
vi.mock('./tabs/agents-settings/AgentsSettingsTab', () => ({
  default: () => <button type="button">Content control</button>,
}));
vi.mock('./tabs/AppearanceSettingsTab', () => ({ default: () => null }));
vi.mock('./tabs/api-settings/CredentialsSettingsTab', () => ({ default: () => null }));
vi.mock('./tabs/VoiceSettingsTab', () => ({ default: () => null }));
vi.mock('./tabs/git-settings/GitSettingsTab', () => ({ default: () => null }));
vi.mock('./tabs/NotificationsSettingsTab', () => ({ default: () => null }));
vi.mock('./tabs/DataSettingsTab', () => ({ default: () => null }));
vi.mock('./tabs/AboutTab', () => ({ default: () => null }));

const { default: Settings } = await import('./Settings');

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open settings</button>
      <Settings isOpen={open} onClose={() => setOpen(false)} />
      <button type="button">Behind settings</button>
    </>
  );
}

beforeEach(() => {
  controller.activeTab = 'agents';
});

describe('Settings dialog accessibility (#279)', () => {
  it('exposes dialog semantics and restores focus to its opener after Escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const opener = screen.getByRole('button', { name: 'Open settings' });
    await user.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'title' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('cycles Tab and Shift+Tab inside the dialog', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open settings' }));

    const close = screen.getByRole('button', { name: 'Close settings' });
    const last = screen.getByRole('button', { name: 'Content control' });

    close.focus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();

    await user.tab();
    expect(close).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Behind settings' })).not.toHaveFocus();
  });

  it('dismisses only when the backdrop itself is pressed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open settings' }));

    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('dialog').parentElement as HTMLElement);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
