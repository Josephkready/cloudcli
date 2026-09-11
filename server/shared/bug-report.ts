/**
 * Pure helpers for the in-app bug reporter.
 *
 * The route layer owns the side effects (inserting into `issue-queue`); everything
 * that shapes an issue out of a user's description plus the session metadata the
 * client collects lives here so it can be unit tested without a GitHub round trip.
 */

/** Longest description we accept; anything past this is almost certainly a paste accident. */
export const MAX_DESCRIPTION_LENGTH = 20000;

/** GitHub truncates long titles in list views, so keep the summary line short. */
export const MAX_TITLE_LENGTH = 80;

/** Per-value cap for metadata; a rogue user agent must not dominate the issue body. */
export const MAX_METADATA_VALUE_LENGTH = 500;

const TITLE_PREFIX = 'Bug: ';

/**
 * Metadata keys we render, in the order they appear in the issue body.
 *
 * This is an allowlist rather than a passthrough: the payload is client-supplied,
 * so unknown keys are dropped instead of being echoed into a public issue.
 */
export const METADATA_FIELDS = [
  ['appVersion', 'App version'],
  ['serverVersion', 'Server version'],
  ['provider', 'Provider'],
  ['sessionId', 'Session ID'],
  ['projectName', 'Project'],
  ['projectPath', 'Project path'],
  ['activeTab', 'Active tab'],
  ['route', 'Route'],
  ['platform', 'Server platform'],
  ['nodeVersion', 'Node version'],
  ['userAgent', 'User agent'],
  // Three rows, because their disagreement is what makes a keyboard report
  // diagnosable. `Viewport` is the layout viewport, which iOS does not shrink
  // for the keyboard — on its own it reads the same in the working and the
  // broken case, which is why #354 and #357 could not be settled from the
  // reports.
  ['viewport', 'Viewport (layout)'],
  ['visualViewport', 'Viewport (visible)'],
  ['keyboardInset', 'Keyboard inset'],
  ['language', 'Language'],
  ['timezone', 'Timezone'],
  ['reportedAt', 'Reported at'],
] as const satisfies ReadonlyArray<readonly [string, string]>;

export type BugReportMetadataKey = (typeof METADATA_FIELDS)[number][0];

export type BugReportMetadata = Partial<Record<BugReportMetadataKey, unknown>>;

/**
 * Marks where `issue-queue`'s worker splices a rendered `### Screenshots`
 * section once every attachment has an uploaded (or tailnet-fallback) URL
 * (dante-config skills/bug-report-button/SKILL.md §9). Must match the literal
 * string `issue-queue` itself replaces — see `issue_queue.github.SCREENSHOTS_TOKEN`.
 *
 * `buildIssueBody` inserts this ONLY when the report actually has attachments
 * — an image-free report never carries it, so its body stays byte-identical
 * to before this existed. `issue-queue` would also strip a token with nothing
 * to splice in if it ever received one, but this app never sends one in that
 * case.
 */
export const SCREENSHOTS_TOKEN = '<!-- issue-queue:screenshots -->';

/**
 * Trims and length-checks the free-text description.
 *
 * @returns the normalized description, or `null` when it is missing/blank/oversized.
 */
export function normalizeDescription(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DESCRIPTION_LENGTH) {
    return null;
  }

  return trimmed;
}

/**
 * Says *why* a description was rejected, so a 20001-character paste isn't told
 * it wrote nothing.
 */
export function describeDescriptionRejection(raw: unknown): string {
  if (typeof raw === 'string' && raw.trim().length > MAX_DESCRIPTION_LENGTH) {
    return `That report is too long — please trim it to ${MAX_DESCRIPTION_LENGTH} characters.`;
  }

  return 'Please describe the bug before filing it.';
}

/**
 * Builds the issue title from the first non-empty line of the description.
 *
 * Truncation happens on a word boundary when there is one, so titles read as
 * sentences rather than as a hard character cut.
 */
export function buildIssueTitle(description: string): string {
  const firstLine =
    description
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';

  if (firstLine.length === 0) {
    return `${TITLE_PREFIX}Untitled report`;
  }

  if (firstLine.length <= MAX_TITLE_LENGTH) {
    return `${TITLE_PREFIX}${firstLine}`;
  }

  const clipped = firstLine.slice(0, MAX_TITLE_LENGTH - 1);
  const lastSpace = clipped.lastIndexOf(' ');
  const stem = (lastSpace > MAX_TITLE_LENGTH / 2 ? clipped.slice(0, lastSpace) : clipped).trimEnd();

  return `${TITLE_PREFIX}${stem}…`;
}

/**
 * Coerces one metadata value to a single-line, table-safe, length-capped string.
 *
 * @returns the cleaned value, or `null` when there is nothing worth rendering.
 */
export function normalizeMetadataValue(value: unknown): string | null {
  if (value === null || value === undefined || typeof value === 'object') {
    return null;
  }

  // Pipes would break out of the markdown table cell; newlines would break the row.
  const flattened = String(value).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  if (flattened.length === 0) {
    return null;
  }

  return flattened.length > MAX_METADATA_VALUE_LENGTH
    ? `${flattened.slice(0, MAX_METADATA_VALUE_LENGTH - 1)}…`
    : flattened;
}

/**
 * Renders the allowlisted metadata as a markdown table.
 *
 * @returns the table, or an empty string when no field survived normalization.
 */
export function formatMetadataTable(metadata: BugReportMetadata): string {
  const rows = METADATA_FIELDS.flatMap(([key, label]) => {
    const value = normalizeMetadataValue(metadata[key]);
    return value === null ? [] : [`| ${label} | \`${value}\` |`];
  });

  if (rows.length === 0) {
    return '';
  }

  return ['| Field | Value |', '| --- | --- |', ...rows].join('\n');
}

/**
 * Assembles the full issue body: the user's report verbatim, then (when
 * screenshots were attached) the `SCREENSHOTS_TOKEN` placeholder, then the
 * session metadata, then a marker so triage can tell in-app reports from
 * hand-filed ones.
 *
 * `hasAttachments` inserts the token right after the report and before the
 * collapsed "Session details" block, so screenshots land ABOVE the fold once
 * `issue-queue` splices them in — never inside the metadata table, which is
 * for structured host facts a triager opens on demand, not user-attached
 * content they should see without expanding anything. Omitted (the default)
 * when there is nothing attached, so a plain report's body is unchanged.
 */
export function buildIssueBody(
  description: string,
  metadata: BugReportMetadata,
  options: { hasAttachments?: boolean } = {},
): string {
  const sections = ['### What happened', '', description];

  if (options.hasAttachments) {
    sections.push('', SCREENSHOTS_TOKEN);
  }

  const table = formatMetadataTable(metadata);
  if (table) {
    sections.push('', '### Session details', '', table);
  }

  sections.push('', '---', '', '_Filed from the CloudCLI in-app bug reporter._');

  return sections.join('\n');
}

/** `owner/name`, using GitHub's actual character rules for both halves. */
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

/** The fork this app is developed in; bug reports land here unless overridden. */
export const DEFAULT_BUG_REPORT_REPO = 'Josephkready/cloudcli';

/**
 * Resolves which repository issues are filed against.
 *
 * `BUG_REPORT_REPO` lets a deployment retarget the reporter; a malformed value
 * falls back to the default rather than being handed to the queue CLI as-is.
 */
export function resolveBugReportRepo(env: Record<string, string | undefined> = process.env): string {
  const configured = (env.BUG_REPORT_REPO ?? '').trim();
  return REPO_PATTERN.test(configured) ? configured : DEFAULT_BUG_REPORT_REPO;
}
