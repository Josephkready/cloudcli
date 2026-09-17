import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';

import type { ProviderModelOption } from '../../../../types/app';

interface EffortDropdownProps {
  effort: string;
  availableEffortOptions: NonNullable<ProviderModelOption['effort']>['values'];
  onSelectEffort: (effort: string) => void;
  // Once a conversation has messages, switching reasoning effort breaks the
  // prompt cache and can raise cost, so a change is confirmed first (#499).
  conversationStarted?: boolean;
}

/**
 * Reasoning-effort picker rendered in the composer toolbar.
 *
 * The menu is portaled to `document.body`. On touch devices the browser fires
 * `pointerdown`/`pointerup` on a tapped option but synthesizes no compatibility
 * `click`, so a click-only handler never selects (the menu just stays open —
 * the mobile "won't select" bug). We therefore select on a non-mouse
 * `pointerup` as well; mouse and keyboard keep going through `onClick`, and
 * because touch produces no click there is no double-fire.
 */
export default function EffortDropdown({
  effort,
  availableEffortOptions,
  onSelectEffort,
  conversationStarted = false,
}: EffortDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  // The effort a user picked that still needs mid-conversation confirmation
  // before it is applied (#499). Null when no change is pending.
  const [pendingEffort, setPendingEffort] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  } | null>(null);

  const effortOptions = useMemo(
    () => [{ value: 'default' }, ...availableEffortOptions],
    [availableEffortOptions],
  );
  const selectedEffortLabel = effort === 'default' ? 'Default' : effort;

  const updatePosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    setPosition({
      left: rect.left,
      top: rect.top - 8,
      maxHeight: Math.max(96, rect.top - 16),
    });
  }, []);

  const applyEffort = useCallback(
    (value: string) => {
      onSelectEffort(value);
      setPendingEffort(null);
      setIsOpen(false);
    },
    [onSelectEffort],
  );

  const selectEffort = useCallback(
    (value: string) => {
      // No-op selection of the already-active effort: never warn, just close.
      if (value === effort) {
        setIsOpen(false);
        return;
      }
      // Mid-conversation, defer the change to an explicit confirmation so the
      // user knows it breaks prompt caching (#499). Otherwise apply at once.
      if (conversationStarted) {
        setPendingEffort(value);
        return;
      }
      applyEffort(value);
    },
    [applyEffort, conversationStarted, effort],
  );

  // A pending confirmation only makes sense while the menu is open; drop it
  // whenever the menu closes so reopening starts from the option list (#499).
  useEffect(() => {
    if (!isOpen) {
      setPendingEffort(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !containerRef.current?.contains(target)
        && !menuRef.current?.contains(target)
      ) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setIsOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    updatePosition();

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [isOpen, updatePosition]);

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          updatePosition();
          setIsOpen((current) => !current);
        }}
        // `touch:hit-44` only extends the tap target, not the painted trigger,
        // so the composer row keeps its 32px rhythm on every viewport (#275).
        className="touch:hit-44 flex h-8 items-center gap-1.5 rounded-lg border border-border/60 bg-muted/40 px-2 text-xs font-medium text-foreground transition-colors duration-fast hover:bg-muted"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label="Select reasoning effort"
        title="Select reasoning effort"
      >
        <span className="hidden text-[11px] text-muted-foreground sm:inline">Effort</span>
        <span className="max-w-16 truncate capitalize sm:max-w-20">{selectedEffortLabel}</span>
        <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && position && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[100] min-w-36 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-lg"
          style={{
            left: position.left,
            top: position.top,
            maxHeight: position.maxHeight,
            transform: 'translateY(-100%)',
          }}
          role={pendingEffort ? 'alertdialog' : 'menu'}
          aria-label={pendingEffort ? 'Confirm reasoning effort change' : undefined}
        >
          {pendingEffort ? (
            <div className="max-w-[15rem] p-2">
              <p className="text-xs text-foreground">
                Change reasoning effort to{' '}
                <span className="font-semibold capitalize">
                  {pendingEffort === 'default' ? 'Default' : pendingEffort}
                </span>
                ?
              </p>
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                Switching effort mid-conversation breaks prompt caching and can increase cost.
              </p>
              <div className="mt-2 flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setPendingEffort(null)}
                  onPointerUp={(event: ReactPointerEvent<HTMLButtonElement>) => {
                    if (event.pointerType !== 'mouse') {
                      setPendingEffort(null);
                    }
                  }}
                  className="rounded px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
                >
                  Keep {effort === 'default' ? 'Default' : effort}
                </button>
                <button
                  type="button"
                  onClick={() => applyEffort(pendingEffort)}
                  onPointerUp={(event: ReactPointerEvent<HTMLButtonElement>) => {
                    if (event.pointerType !== 'mouse') {
                      applyEffort(pendingEffort);
                    }
                  }}
                  className="rounded bg-primary px-2 py-1 text-xs font-medium capitalize text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  Change to {pendingEffort === 'default' ? 'Default' : pendingEffort}
                </button>
              </div>
            </div>
          ) : (
            effortOptions.map((option) => {
            const isSelected = option.value === effort;
            const label = option.value === 'default' ? 'Default' : option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                onClick={() => selectEffort(option.value)}
                onPointerUp={(event: ReactPointerEvent<HTMLButtonElement>) => {
                  // Touch/pen taps do not emit a synthesized click on portaled
                  // content, so handle selection here; mouse stays on onClick.
                  if (event.pointerType !== 'mouse') {
                    selectEffort(option.value);
                  }
                }}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs capitalize transition-colors ${
                  isSelected
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'
                }`}
              >
                <span className="flex h-3 w-3 items-center justify-center">
                  {isSelected && <Check className="h-3 w-3 text-primary" />}
                </span>
                <span>{label}</span>
              </button>
            );
            })
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
