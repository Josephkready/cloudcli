import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import NotificationsSettingsTab from './NotificationsSettingsTab';

describe('NotificationsSettingsTab', () => {
  it('surfaces a push subscription failure next to the control', () => {
    render(
      <NotificationsSettingsTab
        notificationPreferences={{
          channels: { inApp: true, webPush: false, sound: true },
          events: { actionRequired: true, stop: true, error: true },
        }}
        onNotificationPreferencesChange={vi.fn()}
        pushPermission="granted"
        isPushSubscribed={false}
        isPushLoading={false}
        pushError="Could not load push notification configuration (HTTP 500)."
        onEnablePush={vi.fn()}
        onDisablePush={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500');
  });
});
