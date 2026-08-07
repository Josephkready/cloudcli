/**
 * The closed feature inventory behind local usage counting (issue #248).
 *
 * This list is deliberately a **closed literal union**, not a free-form string:
 *
 * - It *is* the feature inventory. Reading this file tells you what surface the
 *   app claims to have, and the readout (`cloudcli usage`) zero-fills every key
 *   here, so a feature nobody touches shows up as an explicit `0` rather than
 *   as a silently missing row.
 * - It cannot drift. `recordFeatureUse` only accepts a member of this union, so
 *   a typo is a type error rather than a phantom key nobody ever reads.
 * - Deleting a feature fails typecheck. When the evidence-based lean-out round 2
 *   removes a feature, its call site and its key must go together — which is the
 *   point of instrumenting in the first place.
 *
 * Keys are aggregate only: how often and how recently a feature was touched.
 * Never add a key that encodes *content* (a file path, a prompt, a branch name)
 * — the table must stay a usage counter, not a behavioural record.
 *
 * Shared by both sides of the app: the frontend imports the `FeatureKey` type
 * (erased at build time), the backend imports the runtime list to zero-fill the
 * readout and to reject unknown keys arriving over the wire.
 */
export const FEATURE_KEYS = [
  // --- Tabs -----------------------------------------------------------------
  'tab.chat',
  'tab.shell',
  'tab.files',
  'tab.git',
  // Aggregate across every drop-installed plugin tab (docs/plugins.md). There is
  // no per-plugin key on purpose: the question this answers is "is the plugin
  // subsystem worth keeping at all", not "which plugin is popular".
  'tab.plugin',

  // --- Chat -----------------------------------------------------------------
  'chat.send',
  'chat.slash_command',
  'chat.file_mention',
  'chat.image_attach',
  'chat.voice_input',
  'chat.queue_message',
  'chat.interrupt',
  'chat.model_change',
  'chat.effort_change',
  'chat.permission_mode_change',

  // --- Files ----------------------------------------------------------------
  'files.open_editor',
  'files.save',
  'files.upload',
  'files.context_menu',
  'files.search',

  // --- Git ------------------------------------------------------------------
  'git.commit',
  'git.stage',
  'git.discard',
  'git.branch_create',
  'git.branch_switch',
  'git.history_view',
  'git.revert',
  'git.ai_commit_message',

  // --- Navigation -----------------------------------------------------------
  'palette.open',
  'palette.action',
  'sidebar.search',
  'sidebar.archived_view',
  'session.archive',
  'session.rename',
  'project.create',
  'project.rename',
  'project.star',

  // --- Config ---------------------------------------------------------------
  // One key per Settings tab, so an untouched settings tab is visible as a zero
  // (the tab ids come from SettingsSidebar's NAV_ITEMS).
  'settings.tab.agents',
  'settings.tab.appearance',
  'settings.tab.git',
  'settings.tab.api',
  'settings.tab.voice',
  'settings.tab.notifications',
  'settings.tab.data',
  'settings.tab.about',
  'mcp.server_add',
  'skills.install',
  'notifications.push',

  // --- Feedback -------------------------------------------------------------
  // Opens vs. actually-filed reports: the gap between them says whether the
  // reporter is discoverable but too costly to finish.
  'bug_report.open',
  'bug_report.submit',
] as const;

/** A member of the closed feature inventory above. */
export type FeatureKey = (typeof FEATURE_KEYS)[number];

const KNOWN_KEYS: ReadonlySet<string> = new Set(FEATURE_KEYS);

/**
 * Narrows an untrusted value (a request body, a stored row) to a known key.
 * Anything else is dropped rather than counted, so a stale client or a hand-made
 * request cannot invent inventory entries.
 */
export const isFeatureKey = (value: unknown): value is FeatureKey =>
  typeof value === 'string' && KNOWN_KEYS.has(value);
