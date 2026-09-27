import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const refreshProjects = vi.fn();
const bulkArchiveSessionsByAge = vi.fn();
const cancelBulkArchiveByAge = vi.fn();
const confirmBulkArchiveByAge = vi.fn();

let prompt: unknown = null;

vi.mock('@/contexts/PaletteOpsContext', () => ({
  usePaletteOps: () => ({ refreshProjects }),
}));

vi.mock('../../../sidebar/hooks/useBulkArchiveByAge', () => ({
  useBulkArchiveByAge: () => ({
    bulkArchiveByAgePrompt: prompt,
    bulkArchiveSessionsByAge,
    cancelBulkArchiveByAge,
    confirmBulkArchiveByAge,
  }),
}));

const { default: DataSettingsTab } = await import('./DataSettingsTab');

beforeEach(() => {
  prompt = null;
  refreshProjects.mockReset();
  bulkArchiveSessionsByAge.mockReset();
  cancelBulkArchiveByAge.mockReset();
  confirmBulkArchiveByAge.mockReset();
});

describe('DataSettingsTab', () => {
  it('renders the archive preset buttons and triggers bulk archive on click', () => {
    render(<DataSettingsTab />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(3);
    fireEvent.click(buttons[0]);
    expect(bulkArchiveSessionsByAge).toHaveBeenCalledWith(7);
    fireEvent.click(buttons[1]);
    expect(bulkArchiveSessionsByAge).toHaveBeenCalledWith(30);
    fireEvent.click(buttons[2]);
    expect(bulkArchiveSessionsByAge).toHaveBeenCalledWith(90);
  });

  it('renders and confirms the bulk archive confirmation prompt when active', () => {
    prompt = { prompt: { kind: 'confirm', message: 'Archive 5 conversations?' }, olderThanDays: 30 };
    render(<DataSettingsTab />);
    expect(screen.getByText('Archive 5 conversations?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^archive$/i }));
    expect(confirmBulkArchiveByAge).toHaveBeenCalled();
  });

  it('cancels the bulk archive confirmation prompt', () => {
    prompt = { prompt: { kind: 'confirm', message: 'Archive 5 conversations?' }, olderThanDays: 30 };
    render(<DataSettingsTab />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(cancelBulkArchiveByAge).toHaveBeenCalled();
  });
});
