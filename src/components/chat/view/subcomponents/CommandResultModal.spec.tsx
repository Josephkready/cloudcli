import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import CommandResultModal from './CommandResultModal';
import { readFavoriteModelIds, writeFavoriteModelIds } from '../../utils/modelFavorites';

const models = Array.from({ length: 8 }, (_, index) => ({
  value: `model-${index + 1}`,
  label: `Model ${index + 1}`,
  description: `Description for model ${index + 1}`,
}));

function renderModelsModal(overrides: Partial<React.ComponentProps<typeof CommandResultModal>> = {}) {
  const onClose = overrides.onClose ?? vi.fn();
  const onHardRefreshProviderModels = overrides.onHardRefreshProviderModels ?? vi.fn();
  const onSelectProviderModel =
    overrides.onSelectProviderModel ??
    vi.fn().mockResolvedValue({
      scope: 'default',
      changed: true,
      model: 'model-1',
    });

  const utils = render(
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
      onClose={onClose}
      providerModelCatalog={{}}
      providerModelCacheCatalog={{}}
      providerModelsRefreshing={false}
      onHardRefreshProviderModels={onHardRefreshProviderModels}
      currentSessionId={null}
      onSelectProviderModel={onSelectProviderModel}
      {...overrides}
    />,
  );
  return { onClose, onHardRefreshProviderModels, onSelectProviderModel, ...utils };
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

describe('CommandResultModal general behavior', () => {
  it('renders nothing (dialog closed) when payload is null', () => {
    render(
      <CommandResultModal
        payload={null}
        onClose={vi.fn()}
        providerModelCatalog={{}}
        providerModelCacheCatalog={{}}
        providerModelsRefreshing={false}
        onHardRefreshProviderModels={vi.fn()}
        currentSessionId={null}
        onSelectProviderModel={vi.fn()}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('calls onClose when the header close button is clicked', () => {
    const { onClose } = renderModelsModal();
    fireEvent.click(screen.getByLabelText('Close command result modal'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the footer Close button is clicked on a non-models modal', () => {
    const onClose = vi.fn();
    render(
      <CommandResultModal
        payload={{ kind: 'status', data: {} }}
        onClose={onClose}
        providerModelCatalog={{}}
        providerModelCacheCatalog={{}}
        providerModelsRefreshing={false}
        onHardRefreshProviderModels={vi.fn()}
        currentSessionId={null}
        onSelectProviderModel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('uses non-fullscreen classes and shows the footer for a non-models modal', () => {
    render(
      <CommandResultModal
        payload={{ kind: 'help', data: {} }}
        onClose={vi.fn()}
        providerModelCatalog={{}}
        providerModelCacheCatalog={{}}
        providerModelsRefreshing={false}
        onHardRefreshProviderModels={vi.fn()}
        currentSessionId={null}
        onSelectProviderModel={vi.fn()}
      />,
    );
    expect(screen.getByRole('dialog')).not.toHaveClass('rounded-none');
    expect(screen.getByText('Esc closes the modal.').parentElement?.parentElement).toHaveClass('flex');
    expect(screen.getAllByText('Help & Shortcuts').length).toBeGreaterThan(0);
    expect(screen.getByText(/Search built-ins/)).toBeInTheDocument();
  });

  it('falls back to "Command Result" title when kind is unknown/missing', () => {
    render(
      <CommandResultModal
        payload={{ kind: undefined as any, data: {} }}
        onClose={vi.fn()}
        providerModelCatalog={{}}
        providerModelCacheCatalog={{}}
        providerModelsRefreshing={false}
        onHardRefreshProviderModels={vi.fn()}
        currentSessionId={null}
        onSelectProviderModel={vi.fn()}
      />,
    );
    expect(screen.getAllByText('Command Result').length).toBeGreaterThan(0);
  });
});

describe('CommandResultModal help content', () => {
  const helpCommands = [
    { name: '/foo', description: 'Does foo things', namespace: 'user' },
    { name: '/bar', description: 'Does bar things' },
  ];

  function renderHelp(commands = helpCommands) {
    return render(
      <CommandResultModal
        payload={{ kind: 'help', data: { commands } }}
        onClose={vi.fn()}
        providerModelCatalog={{}}
        providerModelCacheCatalog={{}}
        providerModelsRefreshing={false}
        onHardRefreshProviderModels={vi.fn()}
        currentSessionId={null}
        onSelectProviderModel={vi.fn()}
      />,
    );
  }

  it('renders provided commands with namespace badges and descriptions', () => {
    renderHelp();
    expect(screen.getByText('/foo')).toBeInTheDocument();
    expect(screen.getByText('Does foo things')).toBeInTheDocument();
    expect(screen.getByText('user')).toBeInTheDocument();
    expect(screen.getByText('builtin')).toBeInTheDocument();
  });

  it('falls back to built-in commands when data.commands is empty', () => {
    renderHelp([]);
    expect(screen.getByText('/models')).toBeInTheDocument();
    expect(screen.getByText('/help')).toBeInTheDocument();
  });

  it('shows a placeholder description when a command has none', () => {
    renderHelp([{ name: '/nodesc', description: '' }]);
    expect(screen.getByText('No description available.')).toBeInTheDocument();
  });

  it('filters commands by the search query', () => {
    renderHelp();
    const input = screen.getByPlaceholderText('Filter commands...');
    fireEvent.change(input, { target: { value: 'foo' } });
    expect(screen.getByText('/foo')).toBeInTheDocument();
    expect(screen.queryByText('/bar')).not.toBeInTheDocument();
  });

  it('shows "no commands match" empty state for an unmatched filter', () => {
    renderHelp();
    const input = screen.getByPlaceholderText('Filter commands...');
    fireEvent.change(input, { target: { value: 'zzzznomatch' } });
    expect(screen.getByText('No commands match that filter.')).toBeInTheDocument();
  });

  it('filters using description and namespace text too', () => {
    renderHelp();
    const input = screen.getByPlaceholderText('Filter commands...');
    fireEvent.change(input, { target: { value: 'bar things' } });
    expect(screen.getByText('/bar')).toBeInTheDocument();
    expect(screen.queryByText('/foo')).not.toBeInTheDocument();
  });
});

describe('CommandResultModal cost content', () => {
  it('renders token usage with breakdown when present', () => {
    render(
      <CommandResultModal
        payload={{
          kind: 'cost',
          data: {
            tokenUsage: { used: 1234, total: 5000 },
            tokenBreakdown: { input: 800, output: 434 },
            provider: 'claude',
            model: 'sonnet-5',
          },
        }}
        onClose={vi.fn()}
        providerModelCatalog={{}}
        providerModelCacheCatalog={{}}
        providerModelsRefreshing={false}
        onHardRefreshProviderModels={vi.fn()}
        currentSessionId={null}
        onSelectProviderModel={vi.fn()}
      />,
    );
    expect(screen.getByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('800')).toBeInTheDocument();
    expect(screen.getByText('434')).toBeInTheDocument();
    expect(screen.getByText('5,000')).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('sonnet-5')).toBeInTheDocument();
  });

  it('shows "Unavailable" breakdown and omits context window row when data is sparse', () => {
    render(
      <CommandResultModal
        payload={{ kind: 'cost', data: {} }}
        onClose={vi.fn()}
        providerModelCatalog={{}}
        providerModelCacheCatalog={{}}
        providerModelsRefreshing={false}
        onHardRefreshProviderModels={vi.fn()}
        currentSessionId={null}
        onSelectProviderModel={vi.fn()}
      />,
    );
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Context window')).not.toBeInTheDocument();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
    expect(screen.getByText('0')).toBeInTheDocument();
  });
});

describe('CommandResultModal status content', () => {
  it('renders known status fields', () => {
    render(
      <CommandResultModal
        payload={{
          kind: 'status',
          data: {
            packageName: 'my-app',
            version: '1.2.3',
            uptime: '2h',
            provider: 'codex',
            model: 'gpt-x',
            nodeVersion: 'v22',
            platform: 'linux',
            pid: 4242,
            memoryUsage: { rssMb: 128 },
          },
        }}
        onClose={vi.fn()}
        providerModelCatalog={{}}
        providerModelCacheCatalog={{}}
        providerModelsRefreshing={false}
        onHardRefreshProviderModels={vi.fn()}
        currentSessionId={null}
        onSelectProviderModel={vi.fn()}
      />,
    );
    expect(screen.getByText('my-app')).toBeInTheDocument();
    expect(screen.getByText('1.2.3')).toBeInTheDocument();
    expect(screen.getByText('2h')).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('gpt-x')).toBeInTheDocument();
    expect(screen.getByText('v22')).toBeInTheDocument();
    expect(screen.getByText('linux')).toBeInTheDocument();
    expect(screen.getByText('128 MB RSS')).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => element?.textContent === 'Process #4242 is responding.'),
    ).toBeInTheDocument();
  });

  it('falls back to Unknown values and generic "status" pid text when data is sparse', () => {
    render(
      <CommandResultModal
        payload={{ kind: 'status', data: {} }}
        onClose={vi.fn()}
        providerModelCatalog={{}}
        providerModelCacheCatalog={{}}
        providerModelsRefreshing={false}
        onHardRefreshProviderModels={vi.fn()}
        currentSessionId={null}
        onSelectProviderModel={vi.fn()}
      />,
    );
    expect(screen.getByText('claude-code-ui')).toBeInTheDocument();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
    expect(
      screen.getByText((_, element) => element?.textContent === 'Process status is responding.'),
    ).toBeInTheDocument();
  });
});

describe('CommandResultModal models content', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('selects a model, calls onSelectProviderModel, and shows the default-scope notice', async () => {
    const onSelectProviderModel = vi.fn().mockResolvedValue({
      scope: 'default',
      changed: true,
      model: 'model-2',
    });
    renderModelsModal({ onSelectProviderModel });

    fireEvent.click(screen.getByLabelText('Select model model-2'));

    expect(onSelectProviderModel).toHaveBeenCalledWith('claude', 'model-2', null);
    await waitFor(() => {
      expect(screen.getByText('Default Claude model set to model-2.')).toBeInTheDocument();
    });
  });

  it('shows a session-scoped notice and marks the pending model when scope is session', async () => {
    const onSelectProviderModel = vi.fn().mockResolvedValue({
      scope: 'session',
      changed: true,
      model: 'model-3',
    });
    renderModelsModal({ onSelectProviderModel, currentSessionId: 'sess-1' });

    fireEvent.click(screen.getByLabelText('Select model model-3'));

    await waitFor(() => {
      expect(screen.getByText('Next response will resume with model-3.')).toBeInTheDocument();
    });
    expect(screen.getByText('→ model-3 next')).toBeInTheDocument();
    expect(screen.getByText('Applies next response')).toBeInTheDocument();
  });

  it('shows an error notice when onSelectProviderModel rejects with an Error', async () => {
    const onSelectProviderModel = vi.fn().mockRejectedValue(new Error('boom'));
    renderModelsModal({ onSelectProviderModel });

    fireEvent.click(screen.getByLabelText('Select model model-2'));

    await waitFor(() => {
      expect(screen.getByText('boom')).toBeInTheDocument();
    });
  });

  it('shows a generic error notice when onSelectProviderModel rejects with a non-Error', async () => {
    const onSelectProviderModel = vi.fn().mockRejectedValue('nope');
    renderModelsModal({ onSelectProviderModel });

    fireEvent.click(screen.getByLabelText('Select model model-2'));

    await waitFor(() => {
      expect(screen.getByText('Unable to change the model right now.')).toBeInTheDocument();
    });
  });

  it('shows the session hint copy when a concrete session id is present and no notice yet', () => {
    renderModelsModal({ currentSessionId: 'sess-42' });
    expect(screen.getByText('Your choice applies to this session on the next response.')).toBeInTheDocument();
  });

  it('shows the default hint copy when there is no session id', () => {
    renderModelsModal({ currentSessionId: null });
    expect(screen.getByText('Your choice becomes the default model for new turns.')).toBeInTheDocument();
  });

  it('disables all model buttons while a selection is in flight', async () => {
    let resolveSelect: (value: any) => void = () => {};
    const onSelectProviderModel: React.ComponentProps<typeof CommandResultModal>['onSelectProviderModel'] = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSelect = resolve;
        }),
    ) as any;
    renderModelsModal({ onSelectProviderModel });

    fireEvent.click(screen.getByLabelText('Select model model-2'));
    expect(screen.getByLabelText('Select model model-1')).toBeDisabled();
    expect(screen.getByLabelText('Select model model-3')).toBeDisabled();

    resolveSelect({ scope: 'default', changed: true, model: 'model-2' });
    await waitFor(() => {
      expect(screen.getByLabelText('Select model model-1')).not.toBeDisabled();
    });
  });

  it('toggles favorite state, persists it, and floats favorites to the top', () => {
    renderModelsModal();

    const favoriteButton = screen.getByLabelText('Add model-5 to favorites');
    fireEvent.click(favoriteButton);

    expect(screen.getByLabelText('Remove model-5 from favorites')).toBeInTheDocument();
    expect(readFavoriteModelIds('claude')).toContain('model-5');

    const optionValues = screen
      .getAllByRole('button', { name: /^Select model / })
      .map((button) => button.getAttribute('aria-label'));
    expect(optionValues[0]).toBe('Select model model-5');
  });

  it('does not trigger model selection when clicking the favorite star', () => {
    const onSelectProviderModel = vi.fn().mockResolvedValue({
      scope: 'default',
      changed: true,
      model: 'model-1',
    });
    renderModelsModal({ onSelectProviderModel });

    fireEvent.click(screen.getByLabelText('Add model-4 to favorites'));
    expect(onSelectProviderModel).not.toHaveBeenCalled();
  });

  it('loads persisted favorites on mount', () => {
    writeFavoriteModelIds('claude', ['model-6']);
    renderModelsModal();
    expect(screen.getByLabelText('Remove model-6 from favorites')).toBeInTheDocument();
  });

  it('reloads favorites when the active provider changes', () => {
    writeFavoriteModelIds('claude', ['model-1']);
    writeFavoriteModelIds('codex', ['model-3']);

    const { rerender } = renderModelsModal();
    expect(screen.getByLabelText('Remove model-1 from favorites')).toBeInTheDocument();

    rerender(
      <CommandResultModal
        payload={{
          kind: 'models',
          data: {
            current: { provider: 'codex', providerLabel: 'Codex', model: 'model-3' },
            availableOptions: models,
          },
        }}
        onClose={vi.fn()}
        providerModelCatalog={{}}
        providerModelCacheCatalog={{}}
        providerModelsRefreshing={false}
        onHardRefreshProviderModels={vi.fn()}
        currentSessionId={null}
        onSelectProviderModel={vi.fn().mockResolvedValue({ scope: 'default', changed: true, model: 'model-3' })}
      />,
    );

    expect(screen.getByLabelText('Remove model-3 from favorites')).toBeInTheDocument();
  });

  it('does not show a search field when there are 6 or fewer options', () => {
    renderModelsModal({
      payload: {
        kind: 'models',
        data: {
          current: { provider: 'claude', providerLabel: 'Claude', model: 'model-1' },
          availableOptions: models.slice(0, 3),
        },
      },
    } as any);
    expect(screen.queryByPlaceholderText(/Search Claude models/)).not.toBeInTheDocument();
  });

  it('filters model options by the search query', () => {
    renderModelsModal();
    const input = screen.getByPlaceholderText('Search Claude models...');
    fireEvent.change(input, { target: { value: 'model-7' } });
    expect(screen.getByText('model-7')).toBeInTheDocument();
    expect(screen.queryByText('model-2')).not.toBeInTheDocument();
  });

  it('shows the empty state when no models match the search', () => {
    renderModelsModal();
    const input = screen.getByPlaceholderText('Search Claude models...');
    fireEvent.change(input, { target: { value: 'zzzz-none' } });
    expect(screen.getByText('No models match that search.')).toBeInTheDocument();
  });

  it('calls onHardRefreshProviderModels when the refresh button is clicked and reflects the refreshing state', () => {
    const onHardRefreshProviderModels = vi.fn();
    const { rerender } = renderModelsModal({ onHardRefreshProviderModels, providerModelsRefreshing: false });

    const refreshButton = screen.getByLabelText('Refresh model list from providers');
    expect(refreshButton).not.toBeDisabled();
    fireEvent.click(refreshButton);
    expect(onHardRefreshProviderModels).toHaveBeenCalledTimes(1);

    rerender(
      <CommandResultModal
        payload={{
          kind: 'models',
          data: {
            current: { provider: 'claude', providerLabel: 'Claude', model: 'model-1' },
            availableOptions: models,
          },
        }}
        onClose={vi.fn()}
        providerModelCatalog={{}}
        providerModelCacheCatalog={{}}
        providerModelsRefreshing={true}
        onHardRefreshProviderModels={onHardRefreshProviderModels}
        currentSessionId={null}
        onSelectProviderModel={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Refresh model list from providers')).toBeDisabled();
  });

  it('prefers the live provider catalog OPTIONS over availableOptions', () => {
    render(
      <CommandResultModal
        payload={{
          kind: 'models',
          data: {
            current: { provider: 'claude', providerLabel: 'Claude', model: 'live-1' },
            availableOptions: models,
          },
        }}
        onClose={vi.fn()}
        providerModelCatalog={{
          claude: { OPTIONS: [{ value: 'live-1', label: 'Live One' }, { value: 'live-2' }] } as any,
        }}
        providerModelCacheCatalog={{}}
        providerModelsRefreshing={false}
        onHardRefreshProviderModels={vi.fn()}
        currentSessionId={null}
        onSelectProviderModel={vi.fn()}
      />,
    );
    expect(screen.getByText('Live One')).toBeInTheDocument();
    expect(screen.queryByText('model-1')).not.toBeInTheDocument();
  });

  it('falls back to availableModels strings when no availableOptions or live catalog exist', () => {
    render(
      <CommandResultModal
        payload={{
          kind: 'models',
          data: {
            current: { provider: 'claude', providerLabel: 'Claude', model: 'plain-a' },
            availableModels: ['plain-a', 'plain-b'],
          },
        }}
        onClose={vi.fn()}
        providerModelCatalog={{}}
        providerModelCacheCatalog={{}}
        providerModelsRefreshing={false}
        onHardRefreshProviderModels={vi.fn()}
        currentSessionId={null}
        onSelectProviderModel={vi.fn()}
      />,
    );
    expect(within(screen.getByTestId('model-selector-options')).getByText('plain-a')).toBeInTheDocument();
    expect(within(screen.getByTestId('model-selector-options')).getByText('plain-b')).toBeInTheDocument();
  });

  it('falls back to the "Unknown" provider label and default provider when current data is absent', () => {
    render(
      <CommandResultModal
        payload={{ kind: 'models', data: {} }}
        onClose={vi.fn()}
        providerModelCatalog={{}}
        providerModelCacheCatalog={{}}
        providerModelsRefreshing={false}
        onHardRefreshProviderModels={vi.fn()}
        currentSessionId={null}
        onSelectProviderModel={vi.fn()}
      />,
    );
    expect(screen.getByText(/Active model · Claude/)).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });
});
