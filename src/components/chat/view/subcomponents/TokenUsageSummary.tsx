import { ActivityIcon } from 'lucide-react';

import { readTokenBudgetOutput, readTokenBudgetUsed } from '../../utils/tokenBudget';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  onClick?: () => void;
};

const formatTokenCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }

  if (value >= 10_000) {
    return `${Math.round(value / 1_000)}K`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return value.toLocaleString();
};

const readTotal = (usage: Record<string, unknown> | null) => {
  const parsed = Number(usage?.total);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/**
 * The composer's "context" chip.
 *
 * Shows the CURRENT context-window occupancy — `readTokenBudgetUsed` folds
 * both shapes the app's two usage sources emit (the live WS `token_budget`
 * frame and the REST `/token-usage` snapshot) down to one number: input +
 * cache tokens of the latest assistant message. It deliberately excludes
 * output tokens from the headline figure (that reply hasn't been resent as
 * input yet) — those show as a small secondary "+Nk out" when the live frame
 * reports them, since the REST shape never does.
 */
export default function TokenUsageSummary({ usage, onClick }: TokenUsageSummaryProps) {
  const usedTokens = readTokenBudgetUsed(usage);
  const outputTokens = readTokenBudgetOutput(usage);
  const total = readTotal(usage);

  const title = total
    ? `context: ${usedTokens.toLocaleString()} / ${total.toLocaleString()} tokens`
    : `context: ${usedTokens.toLocaleString()} tokens`;

  return (
    <button
      type="button"
      onClick={onClick}
      // Tap target only — `touch:hit-44` leaves the painted chip at h-8 so the
      // composer row stays aligned (#275).
      className="touch:hit-44 inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:gap-2 sm:px-2.5"
      title={title}
      aria-label="Show token usage"
    >
      <span className="grid h-5 w-5 place-items-center rounded-md bg-primary/10 text-primary">
        <ActivityIcon className="h-3.5 w-3.5" />
      </span>
      <span className="font-medium text-foreground">
        {formatTokenCount(usedTokens)}
        {total ? <span className="text-muted-foreground/70">/{formatTokenCount(total)}</span> : null}
      </span>
      <span className="hidden text-muted-foreground/70 sm:inline">context</span>
      {outputTokens && outputTokens > 0 ? (
        <span className="hidden text-muted-foreground/50 sm:inline">+{formatTokenCount(outputTokens)} out</span>
      ) : null}
    </button>
  );
}
