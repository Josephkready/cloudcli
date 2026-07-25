import { useCallback, useEffect, useRef, useState } from 'react';

import { recordFeatureUse } from '../../utils/featureUsage';
import LazySurface, { lazySurface } from '../lazy/LazySurface';

import type { CommandPaletteProps } from './CommandPalette';

const CommandPalette = lazySurface(() => import('./CommandPalette'));

export type CommandPaletteHostProps = Omit<CommandPaletteProps, 'open' | 'onOpenChange'>;

/**
 * Keyboard entry point for the command palette (issue #267).
 *
 * The palette itself — six search sources, the git action set and the cmdk
 * dialog tree — is demand-loaded, so something already in the entry chunk has
 * to own both the Ctrl/Cmd+K listener and the open state. This host is that
 * something: a listener and two booleans, nothing else.
 *
 * Once opened it stays mounted so the sources keep their caches across
 * open/close, which is how the palette behaved when it was eagerly imported.
 */
export default function CommandPaletteHost(props: CommandPaletteHostProps) {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  // The keydown listener is registered once and would otherwise close over a
  // stale `open`; the mirror lets it tell opening from closing so usage counts
  // one open per open rather than one per Cmd+K press.
  const openRef = useRef(false);
  openRef.current = open;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isCmdK =
        (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k';
      if (!isCmdK) return;
      event.preventDefault();
      if (!openRef.current) recordFeatureUse('palette.open');
      setEverOpened(true);
      setOpen((previous) => !previous);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
  }, []);

  if (!everOpened) {
    return null;
  }

  // No skeleton: a modal that has not painted yet should show nothing rather
  // than a placeholder dialog that is replaced a frame later.
  return (
    <LazySurface fallback={null}>
      <CommandPalette {...props} open={open} onOpenChange={handleOpenChange} />
    </LazySurface>
  );
}
