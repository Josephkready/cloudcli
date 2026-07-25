import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import { ClipboardAddon, type IClipboardProvider } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';

import type { Project } from '../../../types/app';
import { copyTextToClipboard } from '../../../utils/clipboard';
import {
  TERMINAL_INIT_DELAY_MS,
  TERMINAL_OPTIONS,
  TERMINAL_RESIZE_DELAY_MS,
} from '../constants/constants';
import {
  installMobileTerminalSelection,
  type MobileTerminalSelectionManager,
} from '../utils/mobileTerminalSelection';
import { sendSocketMessage } from '../utils/socket';
import { ensureXtermFocusStyles } from '../utils/terminalStyles';

// CLIs running inside the pty (e.g. `claude auth login`'s "press c to copy"
// device-flow prompt) write to the clipboard via an OSC 52 escape sequence,
// not a browser event — xterm.js ignores OSC 52 unless a clipboard addon is
// loaded. Routes writes through the same fallback-aware helper the terminal's
// own selection-copy shortcut uses, since `navigator.clipboard` is often
// unavailable on self-hosted, non-HTTPS deployments.
// `ClipboardSelectionType.SYSTEM` is `'c'` (vs. `'p'` for the X11 primary
// selection) — compared as a literal since the addon ships it as a const
// enum, which isolatedModules builds (esbuild/Vite) can't import as a value.
const oscClipboardProvider: IClipboardProvider = {
  readText: async (selection) => {
    if (selection !== 'c') {
      return '';
    }
    try {
      return (await navigator.clipboard?.readText?.()) || '';
    } catch {
      return '';
    }
  },
  writeText: async (selection, text) => {
    if (selection !== 'c') {
      return;
    }
    await copyTextToClipboard(text);
  },
};

// The addon's published typings declare a single `(provider?)` constructor
// param, but the shipped runtime actually takes `(base64?, provider?)` — see
// node_modules/@xterm/addon-clipboard/lib/addon-clipboard.js. Cast to call it
// the way it's really implemented.
const ClipboardAddonCtor = ClipboardAddon as unknown as new (
  base64?: unknown,
  provider?: IClipboardProvider,
) => ClipboardAddon;

// One frame of slack: long enough for the browser to paint the shell chrome
// before xterm is built, short enough that the terminal still fills in within
// the same interaction. `requestAnimationFrame` alone is not enough — it runs
// *before* paint, so the construction would still land in the same frame.
const TERMINAL_BUILD_FALLBACK_DELAY_MS = 120;

// Upper bound on how long the terminal runs on xterm's DOM renderer before the
// WebGL upgrade is forced through, and the delay used where there is no
// `requestIdleCallback` (Safari). Long enough for the pty handshake and first
// prompt to land first, short enough that heavy output is on the fast renderer.
const WEBGL_UPGRADE_IDLE_TIMEOUT_MS = 1_000;
const WEBGL_UPGRADE_FALLBACK_DELAY_MS = 300;

/**
 * Schedules the WebGL renderer upgrade off the critical path, returning a
 * canceller (see the call site for why it is not done inline).
 */
function scheduleWebglUpgrade(upgrade: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(upgrade, { timeout: WEBGL_UPGRADE_IDLE_TIMEOUT_MS });
    return () => window.cancelIdleCallback(handle);
  }

  const handle = window.setTimeout(upgrade, WEBGL_UPGRADE_FALLBACK_DELAY_MS);
  return () => window.clearTimeout(handle);
}

type UseShellTerminalOptions = {
  terminalContainerRef: RefObject<HTMLDivElement>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  wsRef: MutableRefObject<WebSocket | null>;
  selectedProject: Project | null | undefined;
  minimal: boolean;
  isRestarting: boolean;
  /** False while the surface is mounted but hidden (see `useStickyMount`). */
  isActive: boolean;
  closeSocket: () => void;
};

type UseShellTerminalResult = {
  isInitialized: boolean;
  clearTerminalScreen: () => void;
  disposeTerminal: () => void;
};

export function useShellTerminal({
  terminalContainerRef,
  terminalRef,
  fitAddonRef,
  wsRef,
  selectedProject,
  minimal,
  isRestarting,
  isActive,
  closeSocket,
}: UseShellTerminalOptions): UseShellTerminalResult {
  const [isInitialized, setIsInitialized] = useState(false);
  const resizeTimeoutRef = useRef<number | null>(null);
  const mobileSelectionRef = useRef<MobileTerminalSelectionManager | null>(null);
  const selectedProjectKey = selectedProject?.fullPath || selectedProject?.path || '';
  const hasSelectedProject = Boolean(selectedProject);

  useEffect(() => {
    ensureXtermFocusStyles();
  }, []);

  const clearTerminalScreen = useCallback(() => {
    if (!terminalRef.current) {
      return;
    }

    terminalRef.current.clear();
    terminalRef.current.write('\x1b[2J\x1b[H');
  }, [terminalRef]);

  const disposeTerminal = useCallback(() => {
    if (mobileSelectionRef.current) {
      mobileSelectionRef.current.dispose();
      mobileSelectionRef.current = null;
    }

    if (terminalRef.current) {
      terminalRef.current.dispose();
      terminalRef.current = null;
    }

    fitAddonRef.current = null;
    setIsInitialized(false);
  }, [fitAddonRef, terminalRef]);

  useEffect(() => {
    const terminalContainer = terminalContainerRef.current;
    if (!terminalContainer || !hasSelectedProject || isRestarting || terminalRef.current) {
      return undefined;
    }

    // Everything below — xterm, four addons, the WebGL context, the first
    // fit — used to run inside the click that opened the tab, which is what
    // made the shell an order of magnitude slower to paint than its siblings
    // (issue #272). It is now built after the chrome has painted; `buildTerminal`
    // returns the teardown for whatever it managed to set up.
    const buildTerminal = () => {
      const nextTerminal = new Terminal(TERMINAL_OPTIONS);
      terminalRef.current = nextTerminal;

      const nextFitAddon = new FitAddon();
      fitAddonRef.current = nextFitAddon;
      nextTerminal.loadAddon(nextFitAddon);

      nextTerminal.loadAddon(new ClipboardAddonCtor(undefined, oscClipboardProvider));

      // Avoid wrapped partial links in compact login flows.
      if (!minimal) {
        nextTerminal.loadAddon(new WebLinksAddon());
      }

      nextTerminal.open(terminalContainer);

      // The WebGL renderer is the single most expensive thing about opening a
      // shell — profiled on this machine at ~700 ms for context creation,
      // shader compilation and the first glyph-atlas build, dwarfing the ~10 ms
      // of `new Terminal()` plus `open()` (#272). xterm renders through its DOM
      // renderer until the addon is loaded, so upgrading in a later task shows
      // the prompt (and lets the pty handshake through) instead of holding the
      // main thread. This is also the order xterm's own docs prescribe: load
      // the addon *after* `open()`.
      const cancelWebglUpgrade = scheduleWebglUpgrade(() => {
        if (terminalRef.current !== nextTerminal) {
          return;
        }

        try {
          const webglAddon = new WebglAddon();
          // The surface now survives tab switches, so its canvas can sit hidden
          // for a long time and the browser is free to drop the GL context.
          // Disposing the addon on loss drops xterm back to its DOM renderer
          // instead of leaving a permanently blank terminal.
          webglAddon.onContextLoss(() => {
            webglAddon.dispose();
          });
          nextTerminal.loadAddon(webglAddon);
        } catch {
          console.warn('[Shell] WebGL renderer unavailable, using Canvas fallback');
        }
      });

      mobileSelectionRef.current = installMobileTerminalSelection(
        nextTerminal,
        terminalContainer,
        {
          onFontSizeChange: (fontSize) => {
            nextTerminal.options.fontSize = fontSize;

            const currentFitAddon = fitAddonRef.current;
            if (currentFitAddon) {
              currentFitAddon.fit();
              sendSocketMessage(wsRef.current, {
                type: 'resize',
                cols: nextTerminal.cols,
                rows: nextTerminal.rows,
              });
            } else {
              nextTerminal.refresh(0, nextTerminal.rows - 1);
            }
          },
        },
      );

      const copyTerminalSelection = async () => {
        const selection = nextTerminal.getSelection();
        if (!selection) {
          return false;
        }

        return copyTextToClipboard(selection);
      };

      const handleTerminalCopy = (event: ClipboardEvent) => {
        if (!nextTerminal.hasSelection()) {
          return;
        }

        const selection = nextTerminal.getSelection();
        if (!selection) {
          return;
        }

        event.preventDefault();

        if (event.clipboardData) {
          event.clipboardData.setData('text/plain', selection);
          return;
        }

        void copyTextToClipboard(selection);
      };

      terminalContainer.addEventListener('copy', handleTerminalCopy);

      nextTerminal.attachCustomKeyEventHandler((event) => {
        if (
          event.type === 'keydown' &&
          (event.ctrlKey || event.metaKey) &&
          event.key?.toLowerCase() === 'c' &&
          nextTerminal.hasSelection()
        ) {
          event.preventDefault();
          event.stopPropagation();
          void copyTerminalSelection();
          return false;
        }

        if (
          event.type === 'keydown' &&
          (event.ctrlKey || event.metaKey) &&
          event.key?.toLowerCase() === 'v'
        ) {
          // Block native paste so data is only injected after clipboard-read resolves.
          event.preventDefault();
          event.stopPropagation();

          if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
            navigator.clipboard
              .readText()
              .then((text) => {
                sendSocketMessage(wsRef.current, {
                  type: 'input',
                  data: text,
                });
              })
              .catch(() => {});
          }

          return false;
        }

        return true;
      });

      const initialFitTimeoutId = window.setTimeout(() => {
        const currentFitAddon = fitAddonRef.current;
        const currentTerminal = terminalRef.current;
        if (!currentFitAddon || !currentTerminal) {
          return;
        }

        currentFitAddon.fit();
        sendSocketMessage(wsRef.current, {
          type: 'resize',
          cols: currentTerminal.cols,
          rows: currentTerminal.rows,
        });
      }, TERMINAL_INIT_DELAY_MS);

      setIsInitialized(true);

      const dataSubscription = nextTerminal.onData((data) => {
        sendSocketMessage(wsRef.current, {
          type: 'input',
          data,
        });
      });

      const resizeObserver = new ResizeObserver(() => {
        if (resizeTimeoutRef.current !== null) {
          window.clearTimeout(resizeTimeoutRef.current);
        }

        resizeTimeoutRef.current = window.setTimeout(() => {
          const currentFitAddon = fitAddonRef.current;
          const currentTerminal = terminalRef.current;
          if (!currentFitAddon || !currentTerminal) {
            return;
          }

          currentFitAddon.fit();
          sendSocketMessage(wsRef.current, {
            type: 'resize',
            cols: currentTerminal.cols,
            rows: currentTerminal.rows,
          });
        }, TERMINAL_RESIZE_DELAY_MS);
      });

      resizeObserver.observe(terminalContainer);

      return () => {
        terminalContainer.removeEventListener('copy', handleTerminalCopy);
        resizeObserver.disconnect();
        cancelWebglUpgrade();
        window.clearTimeout(initialFitTimeoutId);
        if (resizeTimeoutRef.current !== null) {
          window.clearTimeout(resizeTimeoutRef.current);
          resizeTimeoutRef.current = null;
        }
        dataSubscription.dispose();
        closeSocket();
        disposeTerminal();
      };
    };

    let cancelled = false;
    let teardown: (() => void) | null = null;
    let frameId: number | null = null;
    let postPaintTaskId: number | null = null;
    let fallbackTaskId: number | null = null;

    const clearBuildHandles = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
      if (postPaintTaskId !== null) {
        window.clearTimeout(postPaintTaskId);
        postPaintTaskId = null;
      }
      if (fallbackTaskId !== null) {
        window.clearTimeout(fallbackTaskId);
        fallbackTaskId = null;
      }
    };

    const runBuild = () => {
      if (cancelled || teardown) {
        return;
      }

      clearBuildHandles();
      teardown = buildTerminal();
    };

    // rAF runs before paint, so the build has to happen in the task *after* the
    // frame that paints the chrome. The extra timeout is the yield.
    frameId = window.requestAnimationFrame(() => {
      frameId = null;
      postPaintTaskId = window.setTimeout(runBuild, 0);
    });

    // A hidden document never paints and therefore never runs rAF; the
    // provider-login terminal still has to come up in a background tab.
    fallbackTaskId = window.setTimeout(runBuild, TERMINAL_BUILD_FALLBACK_DELAY_MS);

    return () => {
      cancelled = true;
      clearBuildHandles();
      teardown?.();
    };
  }, [
    closeSocket,
    disposeTerminal,
    fitAddonRef,
    isRestarting,
    hasSelectedProject,
    minimal,
    selectedProjectKey,
    terminalContainerRef,
    terminalRef,
    wsRef,
  ]);

  // The surface stays mounted but hidden when another tab is showing (issue
  // #272), and a `display: none` container measures as zero — `FitAddon` bails
  // out, and the renderer can be left holding a stale canvas. So re-measure and
  // repaint on the way back in, not only at mount.
  useEffect(() => {
    if (!isActive || !isInitialized) {
      return undefined;
    }

    const frameId = window.requestAnimationFrame(() => {
      const currentFitAddon = fitAddonRef.current;
      const currentTerminal = terminalRef.current;
      if (!currentFitAddon || !currentTerminal) {
        return;
      }

      const previousCols = currentTerminal.cols;
      const previousRows = currentTerminal.rows;
      currentFitAddon.fit();

      if (currentTerminal.cols !== previousCols || currentTerminal.rows !== previousRows) {
        sendSocketMessage(wsRef.current, {
          type: 'resize',
          cols: currentTerminal.cols,
          rows: currentTerminal.rows,
        });
      } else {
        currentTerminal.refresh(0, currentTerminal.rows - 1);
      }
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [fitAddonRef, isActive, isInitialized, terminalRef, wsRef]);

  return {
    isInitialized,
    clearTerminalScreen,
    disposeTerminal,
  };
}
