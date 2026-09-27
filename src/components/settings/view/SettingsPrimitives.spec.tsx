import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SettingsCard from './SettingsCard';
import SettingsRow from './SettingsRow';
import SettingsSection from './SettingsSection';
import SettingsToggle from './SettingsToggle';
import PremiumFeatureCard from './PremiumFeatureCard';
import { SETTINGS_MAIN_TABS, DEFAULT_PROJECT_SORT_ORDER, DEFAULT_HIDE_CLI_ORIGIN_CHATS, DEFAULT_CODE_EDITOR_SETTINGS } from '../constants/constants';

describe('SettingsCard', () => {
  it('renders children and applies divided/className', () => {
    const { container } = render(
      <SettingsCard divided className="extra-class">
        <span>child</span>
      </SettingsCard>,
    );
    expect(screen.getByText('child')).toBeInTheDocument();
    expect(container.firstChild).toHaveClass('divide-y', 'extra-class');
  });

  it('renders without divided/className', () => {
    render(<SettingsCard><span>plain</span></SettingsCard>);
    expect(screen.getByText('plain')).toBeInTheDocument();
  });
});

describe('SettingsRow', () => {
  it('renders label, optional description, and children', () => {
    render(
      <SettingsRow label="Label" description="Description text" className="row-class">
        <button>action</button>
      </SettingsRow>,
    );
    expect(screen.getByText('Label')).toBeInTheDocument();
    expect(screen.getByText('Description text')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'action' })).toBeInTheDocument();
  });

  it('omits the description block when not provided', () => {
    render(<SettingsRow label="Only label"><span /></SettingsRow>);
    expect(screen.getByText('Only label')).toBeInTheDocument();
  });
});

describe('SettingsSection', () => {
  it('renders title, optional description, and children', () => {
    render(
      <SettingsSection title="Section Title" description="Section description">
        <div>body</div>
      </SettingsSection>,
    );
    expect(screen.getByText('Section Title')).toBeInTheDocument();
    expect(screen.getByText('Section description')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('omits the description when not provided', () => {
    render(<SettingsSection title="No description"><div /></SettingsSection>);
    expect(screen.getByText('No description')).toBeInTheDocument();
  });
});

describe('SettingsToggle', () => {
  it('renders checked state and calls onChange with the inverted value', () => {
    const onChange = vi.fn();
    render(<SettingsToggle checked={false} onChange={onChange} ariaLabel="Toggle me" />);
    const toggle = screen.getByRole('switch', { name: 'Toggle me' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('supports the disabled state', () => {
    const onChange = vi.fn();
    render(<SettingsToggle checked onChange={onChange} ariaLabel="Toggle disabled" disabled />);
    const toggle = screen.getByRole('switch', { name: 'Toggle disabled' });
    expect(toggle).toBeDisabled();
  });
});

describe('PremiumFeatureCard', () => {
  it('renders title, description, icon, and default CTA link', () => {
    render(
      <PremiumFeatureCard icon={<span data-testid="icon" />} title="Feature" description="Feature description" />,
    );
    expect(screen.getByText('Feature')).toBeInTheDocument();
    expect(screen.getByText('Feature description')).toBeInTheDocument();
    expect(screen.getByTestId('icon')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /available with cloudcli pro/i })).toHaveAttribute(
      'href',
      'https://cloudcli.ai',
    );
  });

  it('renders a custom CTA text when provided', () => {
    render(
      <PremiumFeatureCard icon={<span />} title="Feature" description="Desc" ctaText="Upgrade now" />,
    );
    expect(screen.getByRole('link', { name: /upgrade now/i })).toBeInTheDocument();
  });
});

describe('settings constants', () => {
  it('defines a main tab entry for every top-level settings category', () => {
    const ids = SETTINGS_MAIN_TABS.map((tab) => tab.id);
    expect(ids).toEqual(['agents', 'appearance', 'api', 'notifications', 'data', 'about']);
    for (const tab of SETTINGS_MAIN_TABS) {
      expect(tab.label).toBeTruthy();
      expect(tab.keywords).toBeTruthy();
      expect(tab.icon).toBeTruthy();
    }
  });

  it('exposes the shared defaults used across settings and sidebar', () => {
    expect(DEFAULT_PROJECT_SORT_ORDER).toBe('count');
    expect(DEFAULT_HIDE_CLI_ORIGIN_CHATS).toBe(true);
    expect(DEFAULT_CODE_EDITOR_SETTINGS).toEqual({
      wordWrap: false,
      showMinimap: true,
      lineNumbers: true,
      fontSize: '14',
    });
  });
});
