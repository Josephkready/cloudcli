import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import CommandResultModal from './CommandResultModal';

const models = Array.from({ length: 8 }, (_, index) => ({
  value: `model-${index + 1}`,
  label: `Model ${index + 1}`,
  description: `Description for model ${index + 1}`,
}));

function renderModelsModal() {
  render(
    <CommandResultModal
      payload={{
        kind: 'models',
        data: {
          current: {
            provider: 'claude',
            providerLabel: 'Claude',
            model: 'model-1',
          },
          availableOptions: models,
        },
      }}
      onClose={vi.fn()}
      providerModelCatalog={{}}
      providerModelCacheCatalog={{}}
      providerModelsRefreshing={false}
      onHardRefreshProviderModels={vi.fn()}
      currentSessionId={null}
      onSelectProviderModel={vi.fn().mockResolvedValue({
        scope: 'default',
        changed: true,
        model: 'model-1',
      })}
    />,
  );
}

describe('CommandResultModal mobile model selector', () => {
  it('uses the full visual viewport on mobile and restores the centered desktop dialog', () => {
    renderModelsModal();

    expect(screen.getByRole('dialog')).toHaveClass(
      'bottom-0',
      'h-dvh',
      'max-h-dvh',
      'rounded-none',
      'sm:h-[min(92dvh,48rem)]',
      'sm:rounded-3xl',
    );
  });

  it('scrolls the whole model body on mobile instead of a tiny nested card strip', () => {
    renderModelsModal();

    expect(screen.getByTestId('model-selector-scroll-region')).toHaveClass(
      'touch-pan-y',
      'overflow-y-auto',
      'overscroll-contain',
      'sm:overflow-hidden',
    );
    expect(screen.getByTestId('model-selector-options')).not.toHaveClass('overflow-y-auto');
    expect(screen.getByTestId('model-selector-options')).toHaveClass(
      'sm:flex-1',
      'sm:overflow-y-auto',
    );
  });

  it('removes the redundant model footer from the constrained mobile layout', () => {
    renderModelsModal();

    const guidance = screen.getByText('Esc closes the modal.');
    expect(guidance.parentElement?.parentElement).toHaveClass('hidden', 'sm:flex');
  });
});
