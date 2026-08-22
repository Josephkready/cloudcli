import type { AppTab, Project, ProjectSession } from '../../types/app';

/**
 * Browser-supplied facts about the reporter's environment.
 *
 * Kept as an explicit input (rather than read from `window` in here) so the
 * metadata shaping stays pure and unit testable.
 */
export type BrowserEnvironment = {
  userAgent?: string;
  language?: string;
  timezone?: string;
  viewport?: string;
  /**
   * The *visible* area, which on iOS is the only one the soft keyboard shrinks.
   * Absent where the Visual Viewport API is.
   */
  visualViewport?: string;
  /**
   * What the app *published* as the keyboard height — the `--keyboard-height`
   * custom property, read back, not recomputed from the two viewports above.
   * `'unset'` when the app has never published one at all.
   */
  keyboardInset?: string;
  route?: string;
};

export type BugReportMetadataInput = {
  appVersion: string;
  serverVersion?: string | null;
  activeTab: AppTab;
  project: Project | null;
  session: ProjectSession | null;
  environment: BrowserEnvironment;
};

/** The exact shape POSTed as `metadata`; the server allowlists these same keys. */
export type BugReportMetadata = {
  appVersion?: string;
  serverVersion?: string;
  provider?: string;
  sessionId?: string;
  projectName?: string;
  projectPath?: string;
  activeTab?: string;
  route?: string;
  userAgent?: string;
  viewport?: string;
  visualViewport?: string;
  keyboardInset?: string;
  language?: string;
  timezone?: string;
};

/** Trims a value and drops it entirely when there is nothing left. */
function present(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The keyboard height the app has published, read back off `--keyboard-height`.
 *
 * `'unset'` when the variable has never been written, which is a distinct
 * finding: `installKeyboardViewportSync` writes it on resize and on focus and
 * nowhere else, so its absence means that publisher never ran at all — not that
 * it ran and measured nothing.
 *
 * `undefined`, never a throw, when the reading is impossible. This runs on the
 * press that opens the bug reporter, which is the tool of last resort for an app
 * that is already misbehaving, so a hostile `getComputedStyle` must cost one row
 * of the report rather than the whole report.
 */
function readPublishedKeyboardHeight(): string | undefined {
  try {
    const root = window.document?.documentElement;
    if (!root) return undefined;
    const published = window.getComputedStyle(root).getPropertyValue('--keyboard-height');
    return published.trim() || 'unset';
  } catch {
    return undefined;
  }
}

/**
 * Reads the live browser environment. Impure by design — the caller passes the
 * result into {@link buildBugReportMetadata}.
 */
export function readBrowserEnvironment(): BrowserEnvironment {
  if (typeof window === 'undefined') {
    return {};
  }

  let timezone: string | undefined;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // Intl is optional in exotic runtimes; the field is simply omitted.
  }

  // Deliberately three separate numbers, from three genuinely separate sources.
  //
  // `viewport` is the layout viewport, and on iOS it is identical whether or not
  // the keyboard is up — which is why #354 and #357 both reported `390×797` and
  // neither could be diagnosed from the report. `visualViewport` is what is
  // actually visible. `keyboardInset` is what the app *published*, read back off
  // `--keyboard-height`.
  //
  // Their disagreement is the diagnosis. Layout and visual equal while the user
  // says the keyboard is up means the app was never told. Visual short but inset
  // 0 means the app was told and failed to publish. Both correct, field still
  // buried, means a surface is ignoring the offset.
  //
  // That middle row is why the inset must NOT be `innerHeight - visual.height`,
  // however tempting: derived that way, a short visible viewport forces a
  // non-zero inset, the row becomes arithmetically unreachable, and two of the
  // three sources collapse into one. The published variable is the only reading
  // that can disagree with the other two, which is the entire point of it.
  const visual = window.visualViewport;

  return {
    userAgent: window.navigator?.userAgent,
    language: window.navigator?.language,
    timezone,
    viewport: `${window.innerWidth}×${window.innerHeight}`,
    visualViewport: visual ? `${Math.round(visual.width)}×${Math.round(visual.height)}` : undefined,
    keyboardInset: readPublishedKeyboardHeight(),
    route: `${window.location?.pathname ?? ''}${window.location?.search ?? ''}`,
  };
}

/**
 * Builds the metadata block attached to a bug report.
 *
 * Only fields with a real value are included, so the rendered issue table never
 * shows rows like "Model: undefined". The project *path* is included because
 * "works in one space, not another" is a common shape of report; nothing else
 * about the user's filesystem is sent.
 */
export function buildBugReportMetadata({
  appVersion,
  serverVersion,
  activeTab,
  project,
  session,
  environment,
}: BugReportMetadataInput): BugReportMetadata {
  const metadata: BugReportMetadata = {
    appVersion: present(appVersion),
    serverVersion: present(serverVersion),
    provider: present(session?.provider ?? session?.__provider),
    sessionId: present(session?.id),
    projectName: present(project?.displayName),
    projectPath: present(project?.path ?? project?.fullPath),
    activeTab: present(activeTab),
    route: present(environment.route),
    userAgent: present(environment.userAgent),
    viewport: present(environment.viewport),
    visualViewport: present(environment.visualViewport),
    keyboardInset: present(environment.keyboardInset),
    language: present(environment.language),
    timezone: present(environment.timezone),
  };

  // Strip the keys that resolved to nothing so the payload stays tight.
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  ) as BugReportMetadata;
}
