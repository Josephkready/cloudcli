/**
 * Launch intents the installed app can be started with (issue #370).
 *
 * Two manifest features hand the app a URL rather than calling into it:
 *
 * - `shortcuts` — a long-press on the home-screen icon opens `/?new=1`.
 * - `share_target` — sharing text or a link from another app opens
 *   `/?share_title=…&share_text=…&share_url=…`.
 *
 * Both arrive as query parameters on a cold start, so both are parsed here, as
 * plain functions over a query string. Keeping the parsing separate from the
 * effect of acting on it is what makes the awkward cases (a share with only a
 * URL, a title that duplicates the text, junk parameters) testable without a
 * browser.
 */

/**
 * Where a share is parked between arriving and the composer being ready for it.
 *
 * A share can land before any project is selected, and the composer's draft is
 * keyed per project (`draft_input_<projectId>`), so there is no draft to write
 * into yet. Parking it under one key and letting the composer claim it on the
 * next project selection avoids guessing a destination — which project a shared
 * link belongs to is the user's call, not something to infer at launch.
 */
export const SHARED_TEXT_KEY = 'pwa_shared_text';

export type LaunchIntent = {
  /** The `shortcuts` entry was used: start a fresh conversation. */
  newConversation: boolean;
  /** Text shared into the app, already assembled for the composer. */
  sharedText: string | null;
};

/** Trimmed value for `name`, or `''` when absent/blank. */
function readParam(params: URLSearchParams, name: string): string {
  return (params.get(name) ?? '').trim();
}

/**
 * Whether `text` already contains `url` as a whole link rather than as a prefix
 * of a longer one.
 *
 * A plain `text.includes(url)` is wrong in the one direction that loses data:
 * sharing `https://example.com/foo` from a page whose text mentions
 * `https://example.com/foo2` would see the shorter URL "already present" and
 * drop it — and the URL is the one field the Share Target contract actually
 * guarantees. So a match only counts when what follows is a boundary.
 */
function textContainsUrl(text: string, url: string): boolean {
  for (let from = 0; ; from += 1) {
    const at = text.indexOf(url, from);
    if (at === -1) {
      return false;
    }
    const next = text[at + url.length];
    if (next === undefined || /[\s)>\]"',]/.test(next)) {
      return true;
    }
    from = at;
  }
}

/**
 * Assembles the shared fields into one block of composer text.
 *
 * The Web Share Target spec lets a sender populate any combination of `title`,
 * `text` and `url`, and real senders disagree wildly: some put a page's URL in
 * `text`, some in `url`, some send a title identical to the text. So each part
 * is included only when it adds something — a title that merely repeats the text
 * is dropped, and a URL already present in the text is not appended twice.
 */
function composeSharedText(title: string, text: string, url: string): string | null {
  const parts: string[] = [];

  if (title && title !== text && !text.startsWith(title)) {
    parts.push(title);
  }
  if (text) {
    parts.push(text);
  }
  if (url && !textContainsUrl(text, url)) {
    parts.push(url);
  }

  const composed = parts.join('\n\n').trim();
  return composed.length > 0 ? composed : null;
}

/** Reads both launch intents out of a `location.search` string. */
export function parseLaunchParams(search: string): LaunchIntent {
  const params = new URLSearchParams(search);

  return {
    // Presence is the signal, but an explicit `0`/`false` is honoured so a
    // hand-edited or round-tripped URL cannot surprise anyone.
    newConversation: params.has('new') && !['0', 'false'].includes(readParam(params, 'new')),
    sharedText: composeSharedText(
      readParam(params, 'share_title'),
      readParam(params, 'share_text'),
      readParam(params, 'share_url'),
    ),
  };
}

/** Whether a parsed intent asks the app to do anything at all. */
export function hasLaunchIntent(intent: LaunchIntent): boolean {
  return intent.newConversation || intent.sharedText !== null;
}

/**
 * The same URL with every launch parameter removed.
 *
 * The parameters are one-shot instructions, and leaving them in the address bar
 * means a reload re-fires them — re-opening a conversation the user has since
 * navigated away from, or re-inserting a share they already sent. Other query
 * parameters are preserved so this can never eat someone else's state.
 */
export function stripLaunchParams(url: string): string {
  const parsed = new URL(url, 'http://localhost');
  for (const name of ['new', 'share_title', 'share_text', 'share_url']) {
    parsed.searchParams.delete(name);
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
