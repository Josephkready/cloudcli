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
  /** What the app currently believes the keyboard is covering. */
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

  // Deliberately three separate numbers, from three separate sources.
  //
  // `viewport` is the layout viewport, and on iOS it is identical whether or not
  // the keyboard is up — which is why #354 and #357 both reported `390×797` and
  // neither could be diagnosed from the report. `visualViewport` is what is
  // actually visible, and `keyboardInset` is what the app *believes* is covered.
  //
  // Their disagreement is the diagnosis. Layout and visual equal while the user
  // says the keyboard is up means the app was never told. Visual short but
  // inset 0 means the app was told and failed to publish. Both correct, field
  // still buried, means a surface is ignoring the offset. Collapsing any two of
  // these into one source would destroy exactly that discrimination.
  const visual = window.visualViewport;

  return {
    userAgent: window.navigator?.userAgent,
    language: window.navigator?.language,
    timezone,
    viewport: `${window.innerWidth}×${window.innerHeight}`,
    visualViewport: visual ? `${Math.round(visual.width)}×${Math.round(visual.height)}` : undefined,
    keyboardInset: visual
      ? `${Math.max(0, Math.round(window.innerHeight - visual.height))}px`
      : undefined,
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
