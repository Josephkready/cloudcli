/**
 * The measured user journeys.
 *
 * Each flow is a `prepare` phase (unmeasured — puts the app into the state the
 * journey starts from) and a `measure` phase that returns one sample per step.
 * A flow's end-to-end number is the sum of its steps, so steps are always
 * consecutive spans of the same timeline and never overlap.
 *
 * Actions and predicates cross into the page as source strings, evaluated by
 * `bench/instrument.ts`. That indirection exists so a whole multi-checkpoint
 * journey (send → echo → first token → complete → settled) is armed inside the
 * browser before the click lands; timing those checkpoints from Node would lose
 * every gap smaller than a CDP round-trip.
 */

import type { Page } from '@playwright/test';

import { sessionMarker } from './seed.js';
import type { FixtureManifest, StepSample } from './types.js';

// ─── Selectors ───────────────────────────────────────────────────────────────
// Deliberately the same handles the e2e suite uses (`data-slot`, aria-labels),
// so a rename that breaks the benchmark breaks the e2e suite too and gets fixed
// once, rather than leaving the benchmark silently measuring the wrong element.

const COMPOSER = '[data-slot="prompt-input-textarea"]';
const SEND_BUTTON = 'button[aria-label="Send"]';
const STOP_BUTTON = 'button[aria-label="Stop"]';
const NEW_CONVERSATION_BUTTON = 'button[aria-label="New conversation"]';
const REPORT_BUG_BUTTON = 'button[aria-label="Report a bug"]';
const BUG_REPORT_FIELD = '#bug-report-description';
const BUG_REPORT_METADATA_ROW = '[data-testid="bug-report-metadata-row"]';
const CMDK_ITEM = '[cmdk-item]';
const CONVERSATION_LINK = 'a[href^="/session/"]';

const sessionLink = (sessionId: string) => `a[href="/session/${sessionId}"]`;

/** How long any single checkpoint may take before the run is declared broken. */
const STEP_TIMEOUT_MS = 30_000;
/** Quiet period that counts as "the app has stopped fetching". */
const IDLE_QUIET_MS = 400;

// ─── Source-string builders ──────────────────────────────────────────────────

const json = (value: unknown) => JSON.stringify(value);

/** An action that clicks the first match, failing loudly if there is none. */
const clickSource = (selector: string) =>
  `() => { const el = document.querySelector(${json(selector)}); ` +
  `if (!el) { throw new Error('bench: nothing matches ' + ${json(selector)}); } el.click(); }`;

const visible = (selector: string) =>
  `() => { const el = document.querySelector(${json(selector)}); ` +
  'return Boolean(el && el.getClientRects().length > 0); }';

const absent = (selector: string) => `() => document.querySelector(${json(selector)}) === null`;

const countAtLeast = (selector: string, count: number) =>
  `() => document.querySelectorAll(${json(selector)}).length >= ${count}`;

/**
 * True once a rendered message carries the marker the seeder wrote into that
 * session's final turn.
 *
 * Scans the message rows rather than a pane container: `data-testid` on the
 * chat wrapper is not present in every state, and the rows are the thing whose
 * appearance the user is actually waiting on.
 */
const chatShowsMarker = (marker: string) =>
  "() => Array.from(document.querySelectorAll('.chat-message'))" +
  `.some((row) => (row.textContent || '').includes(${json(marker)}))`;

const idle = `() => window.__bench.idleFor(${IDLE_QUIET_MS})`;

/**
 * The app is usable: the conversation list has painted real rows.
 *
 * Not "the composer is visible" — with more than one workspace the app
 * deliberately selects none and shows a project chooser, so a composer is not
 * part of boot. The conversation list is: it is the first thing on screen made
 * of the user's own data, and reaching it means the bundle parsed, the shell
 * mounted, `/api/projects` answered, and React committed the result.
 */
const APP_INTERACTIVE =
  `() => { const rows = document.querySelectorAll(${json(CONVERSATION_LINK)}); ` +
  'return rows.length > 0 && rows[0].getClientRects().length > 0; }';

/** A fresh, empty conversation: composer ready and no transcript on screen. */
const COMPOSER_READY_AND_EMPTY =
  `() => { const composer = document.querySelector(${json(COMPOSER)}); ` +
  'if (!composer || composer.getClientRects().length === 0) return false; ' +
  "return composer.value === '' && document.querySelectorAll('.chat-message').length === 0; }";

// ─── Flow plumbing ───────────────────────────────────────────────────────────

export type FlowContext = {
  page: Page;
  baseURL: string;
  fixture: FixtureManifest;
};

export type StepDefinition = { id: string; description: string };

export type Flow = {
  id: string;
  description: string;
  steps: StepDefinition[];
  /**
   * Whether each iteration needs a brand-new browser context. Only the boot flow
   * does; reusing one context elsewhere is deliberate, since a user does not
   * relaunch the browser between clicking two conversations.
   */
  cold?: boolean;
  prepare(context: FlowContext): Promise<void>;
  measure(context: FlowContext): Promise<StepSample[]>;
};

type RawSample = { ms: number; blockingMs: number; requests: Array<{ url: string; ms: number; bytes: number | null }> };

type Checkpoint = {
  id: string;
  predicate: string;
  /**
   * Time this checkpoint to the instant the last request settled rather than to
   * the instant that could be confirmed.
   *
   * "The app went quiet" is only observable by watching nothing happen for a
   * while, so its predicate necessarily becomes true `IDLE_QUIET_MS` late.
   * Charged to the app, that constant inflates every settle step by the same
   * amount — a 90 ms step reads as 490 ms — which both overstates the flow and
   * shrinks every percentage measured against it.
   */
  endAt?: 'idleStart';
};

/** Runs a `sequence` in the page and labels the resulting samples. */
async function sequence(
  page: Page,
  action: string,
  checkpoints: Checkpoint[],
): Promise<StepSample[]> {
  const samples = await page.evaluate(
    ([actionSource, wire, timeout]) =>
      window.__bench.sequence(
        actionSource as string,
        wire as Array<{ predicate: string; endAt?: 'idleStart' }>,
        timeout as number,
      ),
    [
      action,
      checkpoints.map(({ predicate, endAt }) => ({ predicate, endAt })),
      STEP_TIMEOUT_MS,
    ] as const,
  ) as RawSample[];

  return samples.map((sample, index) => ({ step: checkpoints[index].id, ...sample }));
}

/** Waits (unmeasured) for a predicate to hold — used by `prepare` phases. */
async function settle(page: Page, predicate: string): Promise<void> {
  await page.evaluate(
    ([predicateSource, timeout]) =>
      window.__bench.measure('() => {}', predicateSource as string, timeout as number),
    [predicate, STEP_TIMEOUT_MS] as const,
  );
}

/**
 * Fails fast if the init script did not survive into the page.
 *
 * Without this, a broken instrument shows up as "Cannot read properties of
 * undefined (reading 'sequence')" from whichever flow ran first — which points
 * at the flow rather than at the injection. See `newInstrumentedContext` in
 * `run.ts` for the failure mode this actually guards against.
 */
async function assertInstrumentInstalled(page: Page): Promise<void> {
  const installed = await page.evaluate(() => typeof window.__bench?.sequence === 'function');
  if (!installed) {
    throw new Error(
      'bench: the measurement instrument is missing from the page — the init script failed to evaluate.',
    );
  }
}

/**
 * Drops composer state left behind by an earlier iteration.
 *
 * The composer persists what you typed under `draft_input_<projectId>` (and
 * queued/pending sends under their own keys) so a reload does not lose your
 * writing. Iterations share a browser context, so without this the *second*
 * pass through `typing` or `chat_turn` opens a composer that is already full,
 * and every "an empty composer is ready" predicate waits forever.
 *
 * Runs after navigation (localStorage needs an origin) but before a project is
 * chosen, which is when the composer mounts and reads the draft.
 */
async function clearComposerDrafts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stale = ['draft_input_', 'queued_message_', 'pending_send_'];
    for (const key of Object.keys(localStorage)) {
      if (stale.some((prefix) => key.startsWith(prefix))) {
        localStorage.removeItem(key);
      }
    }
  });
}

/** Loads the app and waits until it is interactive and quiet. */
async function loadApp(context: FlowContext): Promise<void> {
  await context.page.goto(`${context.baseURL}/`, { waitUntil: 'commit' });
  await assertInstrumentInstalled(context.page);
  await clearComposerDrafts(context.page);
  await settle(context.page, APP_INTERACTIVE);
  await settle(context.page, idle);
}

/**
 * Opens a brand-new conversation in the primary project.
 *
 * Shared by every flow that needs an empty composer. Goes through the real
 * picker rather than a URL, because a conversation started any other way skips
 * the project-selection state the composer reads.
 */
async function startNewConversation(context: FlowContext): Promise<void> {
  await context.page.evaluate(
    ([openSource, itemSelector, timeout]) => {
      const open = new Function(`return (${openSource as string});`)() as () => void;
      open();
      return window.__bench.measure(
        '() => {}',
        `() => document.querySelectorAll(${JSON.stringify(itemSelector)}).length > 0`,
        timeout as number,
      );
    },
    [clickSource(NEW_CONVERSATION_BUTTON), CMDK_ITEM, STEP_TIMEOUT_MS] as const,
  );

  await context.page.evaluate(
    ([itemSelector, readySource, timeout]) => {
      const items = document.querySelectorAll(itemSelector as string);
      (items[0] as HTMLElement).click();
      return window.__bench.measure('() => {}', readySource as string, timeout as number);
    },
    [CMDK_ITEM, COMPOSER_READY_AND_EMPTY, STEP_TIMEOUT_MS] as const,
  );

  await settle(context.page, idle);
}

/** Puts text into the composer without measuring the typing. */
async function fillComposer(page: Page, text: string): Promise<void> {
  await page.evaluate(
    ([selector, value]) => {
      const field = document.querySelector(selector as string) as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(field, value as string);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    },
    [COMPOSER, text] as const,
  );
}

/**
 * The four checkpoints of a chat turn, shared by both turn flows so the two are
 * directly comparable — one in a brand-new conversation, one in a long-running
 * one.
 */
const CHAT_TURN_CHECKPOINTS: Checkpoint[] = [
  { id: 'send_to_echo', predicate: countAtLeast('.chat-message.user', 1) },
  { id: 'echo_to_first_token', predicate: countAtLeast('.chat-message.assistant', 1) },
  {
    id: 'first_token_to_complete',
    // Requires the assistant bubble too, so this cannot resolve on the frame
    // before the Stop affordance has even appeared.
    predicate:
      `() => { const stop = document.querySelector(${json(STOP_BUTTON)}); ` +
      `const send = document.querySelector(${json(SEND_BUTTON)}); ` +
      "const assistant = document.querySelectorAll('.chat-message.assistant').length; " +
      'return stop === null && send !== null && assistant > 0; }',
  },
  { id: 'complete_to_settled', predicate: idle, endAt: 'idleStart' },
];

// ─── The message a chat turn actually renders ────────────────────────────────

/**
 * The assistant reply the mock provider echoes back during the chat-turn flow.
 *
 * The mock's default reply is two short frames — fine for asserting that a turn
 * completes, useless for measuring what a turn *costs*, because the expensive
 * part of rendering a reply in this app is markdown parsing and syntax
 * highlighting. `echo:` (see `server/routes/mock-agent-provider.js`) lets the
 * prompt choose the reply, so the benchmark sends a reply shaped like a real
 * one: prose, a fenced code block, a list, and a table.
 */
const ECHOED_REPLY = [
  'Here is what I found while tracing the transcript loader.',
  '',
  'The hot path reads every line of the JSONL before it can answer, so the cost',
  'scales with the whole conversation rather than with the page being requested.',
  '',
  '```ts',
  'export async function fetchHistory(sessionId: string, limit: number) {',
  '  const rows = await readAllRows(sessionId);',
  '  return rows.slice(-limit);',
  '}',
  '```',
  '',
  '- The read is sequential and unbounded.',
  '- Every row is parsed, including the ones that get discarded.',
  '- Normalization allocates a message object per row.',
  '',
  '| stage | cost |',
  '| --- | --- |',
  '| read | O(file) |',
  '| parse | O(rows) |',
  '| render | O(page) |',
  '',
  'The last two are already bounded; the first is not.',
].join('\n');

const TYPED_MESSAGE =
  'Please trace why switching conversations feels slow and summarise the hot path for me.';

// ─── Flows ───────────────────────────────────────────────────────────────────

/**
 * Every flow, in run order.
 *
 * The order is load-bearing at exactly one point: `chat_turn` is last, because
 * it is the only flow that *writes* to the library. Each of its iterations
 * starts a real conversation, and those land at the top of the sidebar with the
 * newest timestamps — run earlier, they would push the conversations the switch
 * flows target further down the list on every iteration, so those flows would
 * be clicking a different row each time.
 */
export function buildFlows(fixture: FixtureManifest): Flow[] {
  const largeMarker = sessionMarker(fixture.targets.largeSessionId);
  const typicalMarker = sessionMarker(fixture.targets.typicalSessionId);

  return [
    {
      id: 'app_boot',
      description: 'Cold load of the app until the composer and conversation list are usable',
      cold: true,
      steps: [
        { id: 'navigation_to_interactive', description: 'Navigation start → composer and conversation list on screen' },
        { id: 'interactive_to_idle', description: 'Interactive → the app stops fetching' },
      ],
      async prepare() {
        // Nothing: a cold flow gets a fresh context, and the navigation itself
        // is the measured action.
      },
      async measure(context) {
        await context.page.goto(`${context.baseURL}/`, { waitUntil: 'commit' });
        await assertInstrumentInstalled(context.page);
        const samples = await context.page.evaluate(
          ([interactiveSource, idleSource, timeout]) => (async () => {
            const interactive = await window.__bench.sinceNavigation(interactiveSource as string, timeout as number);
            const [settled] = await window.__bench.sequence(
              '() => {}',
              [{ predicate: idleSource as string, endAt: 'idleStart' }],
              timeout as number,
            );
            return [interactive, settled];
          })(),
          [APP_INTERACTIVE, idle, STEP_TIMEOUT_MS] as const,
        ) as RawSample[];

        return [
          { step: 'navigation_to_interactive', ...samples[0] },
          { step: 'interactive_to_idle', ...samples[1] },
        ];
      },
    },

    {
      id: 'new_conversation',
      description: 'Start a new conversation from the sidebar picker',
      steps: [
        { id: 'open_picker', description: 'Click "New conversation" → the folder picker lists projects' },
        { id: 'pick_project', description: 'Choose a project → an empty composer is ready to type in' },
      ],
      async prepare(context) {
        await loadApp(context);
      },
      async measure(context) {
        const [openPicker] = await sequence(context.page, clickSource(NEW_CONVERSATION_BUTTON), [
          { id: 'open_picker', predicate: countAtLeast(CMDK_ITEM, 1) },
        ]);

        // The picker click is a separate `sequence` on purpose: choosing a folder
        // is a second user decision, so the think-time between them is not the
        // app's to account for.
        const [pickProject] = await sequence(
          context.page,
          `() => { document.querySelectorAll(${json(CMDK_ITEM)})[0].click(); }`,
          [{ id: 'pick_project', predicate: COMPOSER_READY_AND_EMPTY }],
        );

        return [openPicker, pickProject];
      },
    },

    {
      id: 'typing',
      description: `Type an ${TYPED_MESSAGE.length}-character message into the composer`,
      steps: [
        {
          id: 'input_handling',
          description: 'Total main-thread work across every keystroke (÷ characters = per-key cost)',
        },
      ],
      async prepare(context) {
        await loadApp(context);
        await startNewConversation(context);
      },
      async measure(context) {
        const result = await context.page.evaluate(
          ([selector, text]) => window.__bench.typeText(selector as string, text as string),
          [COMPOSER, TYPED_MESSAGE] as const,
        );

        return [{
          step: 'input_handling',
          // The sum of the per-keystroke spans, not the wall clock: the wall
          // clock includes a deliberate frame wait between keys, which is the
          // display's cadence rather than the app's cost.
          ms: result.keystrokes.reduce((total, value) => total + value, 0),
          blockingMs: result.blockingMs,
          requests: [],
        }];
      },
    },

    {
      id: 'switch_to_large_conversation',
      description: `Open a ${describeSession(fixture, fixture.targets.largeSessionId)} from the sidebar`,
      steps: [
        { id: 'click_to_transcript', description: 'Click the conversation → its messages are on screen' },
        { id: 'transcript_to_settled', description: 'Messages shown → the app stops fetching' },
      ],
      async prepare(context) {
        await loadApp(context);
        // Start from a *different* conversation so the click is a genuine switch
        // rather than a first load, and so the previous transcript has to be
        // torn down — which is part of what a switch costs.
        await openConversation(context, fixture.targets.typicalSessionId, typicalMarker);
      },
      async measure(context) {
        return sequence(context.page, clickSource(sessionLink(fixture.targets.largeSessionId)), [
          { id: 'click_to_transcript', predicate: chatShowsMarker(largeMarker) },
          { id: 'transcript_to_settled', predicate: idle, endAt: 'idleStart' },
        ]);
      },
    },

    {
      id: 'switch_to_typical_conversation',
      description: `Open a ${describeSession(fixture, fixture.targets.typicalSessionId)} from the sidebar`,
      steps: [
        { id: 'click_to_transcript', description: 'Click the conversation → its messages are on screen' },
        { id: 'transcript_to_settled', description: 'Messages shown → the app stops fetching' },
      ],
      async prepare(context) {
        await loadApp(context);
        await openConversation(context, fixture.targets.largeSessionId, largeMarker);
      },
      async measure(context) {
        return sequence(context.page, clickSource(sessionLink(fixture.targets.typicalSessionId)), [
          { id: 'click_to_transcript', predicate: chatShowsMarker(typicalMarker) },
          { id: 'transcript_to_settled', predicate: idle, endAt: 'idleStart' },
        ]);
      },
    },

    {
      id: 'switch_back_warm',
      description: 'Return to a conversation already visited in this session',
      steps: [
        { id: 'click_to_transcript', description: 'Click back → the cached transcript is on screen' },
        { id: 'transcript_to_settled', description: 'Messages shown → the app stops re-fetching' },
      ],
      async prepare(context) {
        await loadApp(context);
        // Visit the target once so its slot is populated, then move away. What
        // this flow measures is the cache path, which is a different code path
        // from a cold open and should be reported separately rather than
        // averaged into it.
        await openConversation(context, fixture.targets.largeSessionId, largeMarker);
        await openConversation(context, fixture.targets.typicalSessionId, typicalMarker);
      },
      async measure(context) {
        return sequence(context.page, clickSource(sessionLink(fixture.targets.largeSessionId)), [
          { id: 'click_to_transcript', predicate: chatShowsMarker(largeMarker) },
          { id: 'transcript_to_settled', predicate: idle, endAt: 'idleStart' },
        ]);
      },
    },

    {
      id: 'bug_report',
      description: 'Open the bug reporter and expand the context it captured',
      steps: [
        { id: 'open_dialog', description: 'Click "Report a bug" → the description field is ready' },
        { id: 'expand_context', description: 'Expand "Session details attached" → the captured metadata renders' },
      ],
      async prepare(context) {
        await loadApp(context);
        await openConversation(context, fixture.targets.typicalSessionId, typicalMarker);
      },
      async measure(context) {
        const [openDialog] = await sequence(context.page, clickSource(REPORT_BUG_BUTTON), [
          { id: 'open_dialog', predicate: visible(BUG_REPORT_FIELD) },
        ]);

        // Submission is deliberately out of scope: `POST /api/bug-report` shells
        // out to an `issue-queue` binary that is not part of the app and is not
        // installed on a bench machine, so timing it would measure a missing
        // dependency's failure path.
        const [expandContext] = await sequence(
          context.page,
          `() => { const buttons = Array.from(document.querySelectorAll('button')); ` +
          "const toggle = buttons.find((button) => /Session details attached/.test(button.textContent || '')); " +
          "if (!toggle) { throw new Error('bench: no session-details toggle'); } toggle.click(); }",
          [{ id: 'expand_context', predicate: countAtLeast(BUG_REPORT_METADATA_ROW, 1) }],
        );

        // Leave the app as it was found, so the next iteration starts clean.
        await context.page.keyboard.press('Escape');
        await settle(context.page, absent(BUG_REPORT_FIELD));

        return [openDialog, expandContext];
      },
    },

    {
      id: 'chat_turn_in_large_conversation',
      description:
        `Send a message inside a ${describeSession(fixture, fixture.targets.largeSessionId)} and watch the turn finish`,
      steps: [
        { id: 'send_to_echo', description: 'Click Send → the user\'s own message appears' },
        { id: 'echo_to_first_token', description: 'User message → the first assistant text is painted' },
        { id: 'first_token_to_complete', description: 'First token → the run finishes and the composer frees up' },
        { id: 'complete_to_settled', description: 'Run complete → the app stops fetching (transcript reconciled)' },
      ],
      async prepare(context) {
        await loadApp(context);
        await openConversation(context, fixture.targets.largeSessionId, largeMarker);
        await fillComposer(context.page, `echo:${ECHOED_REPLY}`);
        await settle(context.page, visible(SEND_BUTTON));
      },
      async measure(context) {
        return sequence(context.page, clickSource(SEND_BUTTON), CHAT_TURN_CHECKPOINTS);
      },
    },

    {
      id: 'chat_turn',
      description: 'Send a message in a new conversation and watch the reply stream in and the run finish',
      steps: [
        { id: 'send_to_echo', description: 'Click Send → the user\'s own message appears' },
        { id: 'echo_to_first_token', description: 'User message → the first assistant text is painted' },
        { id: 'first_token_to_complete', description: 'First token → the run finishes and the composer frees up' },
        { id: 'complete_to_settled', description: 'Run complete → the app stops fetching (transcript reconciled)' },
      ],
      async prepare(context) {
        await loadApp(context);
        await startNewConversation(context);
        // Typed in `prepare`, not measured here: the typing flow owns that cost,
        // and paying it twice would fold keystroke time into the turn.
        await fillComposer(context.page, `echo:${ECHOED_REPLY}`);
        await settle(context.page, visible(SEND_BUTTON));
      },
      async measure(context) {
        return sequence(context.page, clickSource(SEND_BUTTON), CHAT_TURN_CHECKPOINTS);
      },
    },
  ];
}

/** Opens a conversation and waits for it, without measuring — for `prepare`. */
async function openConversation(context: FlowContext, sessionId: string, marker: string): Promise<void> {
  await context.page.evaluate(
    ([selector, markerPredicate, timeout]) => {
      const link = document.querySelector(selector as string) as HTMLElement | null;
      if (!link) {
        throw new Error(`bench: conversation ${selector as string} is not in the sidebar`);
      }
      link.click();
      return window.__bench.measure('() => {}', markerPredicate as string, timeout as number);
    },
    [sessionLink(sessionId), chatShowsMarker(marker), STEP_TIMEOUT_MS] as const,
  );
  await settle(context.page, idle);
}

/** Human-readable size of a seeded session, for flow descriptions. */
function describeSession(fixture: FixtureManifest, sessionId: string): string {
  for (const project of fixture.projects) {
    for (const session of project.sessions) {
      if (session.id === sessionId) {
        return `${session.rows.toLocaleString()}-row / ${(session.bytes / 1024).toFixed(0)} KB conversation`;
      }
    }
  }
  return 'conversation';
}
