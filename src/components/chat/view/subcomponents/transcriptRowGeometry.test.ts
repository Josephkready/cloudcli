import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * A transcript row's box must not change size depending on whether it happens
 * to be on screen (cloudcli#495).
 *
 * `.chat-message` used to carry `content-visibility: auto` with a
 * `contain-intrinsic-size` placeholder. That is a rendering optimisation —
 * the browser skips laying out off-screen rows and substitutes the declared
 * placeholder for their size — but the placeholder is a fixed guess (180px,
 * or 240/96 per role) and a real message is rarely that tall. So every message
 * that left the viewport collapsed to the guess and every one that entered it
 * expanded back, resizing the scrolled content *above* the reader while they
 * were scrolling through it.
 *
 * Measured against a 520-message conversation on WebKit under an iPhone UA, a
 * 240px scroll up moved the message the reader was looking at by as little as
 * 24px, and sometimes moved it the wrong way entirely: the content above had
 * shrunk by 150-215px in the same moment. Chromium hides most of it because it
 * implements CSS scroll anchoring and compensates; WebKit implements none, so
 * on an iPhone it is the whole of the reported symptom.
 *
 * This is a structural assertion because the regression has no local symptom:
 * re-adding the rule breaks nothing that any other test can see, renders
 * identically in a screenshot, and only shows up as the transcript lurching
 * under a thumb on a real phone. `e2e/transcript-scroll-stability.spec.ts`
 * measures the behaviour itself; this names the cause so the next reader does
 * not have to re-derive it.
 *
 * What it does NOT cover, deliberately, because it reads one authored
 * stylesheet as text:
 *   - an inline `style={{ contentVisibility: 'auto' }}` on the row element,
 *   - a Tailwind arbitrary-value utility (`[content-visibility:auto]`), which
 *     is authored in a `className` and never appears in this file,
 *   - a rule in some second stylesheet, since the path below is hardcoded.
 * All three are low-probability today — the repo has exactly one CSS file and
 * this rule was authored here — but a reader treating a green run as proof
 * that the property is absent from the transcript should know the limits.
 * The e2e measurement is what catches those; this catches the cheap case
 * early and explains why it matters.
 */
test('.chat-message does not make its height depend on visibility', () => {
  const cssPath = path.join(process.cwd(), 'src', 'index.css');
  const css = readFileSync(cssPath, 'utf8');

  // Every `.chat-message...` rule body in the stylesheet.
  const ruleBodies = [...css.matchAll(/\.chat-message[^{]*\{([^}]*)\}/g)].map((match) => match[1]);
  assert.ok(ruleBodies.length > 0, 'expected at least one .chat-message rule in src/index.css');

  for (const body of ruleBodies) {
    assert.doesNotMatch(
      body,
      /content-visibility\s*:\s*auto/,
      'content-visibility: auto on a transcript row collapses it to contain-intrinsic-size '
        + 'when it scrolls off screen, moving the content above the reader — see cloudcli#495',
    );
    assert.doesNotMatch(
      body,
      /contain-intrinsic-size/,
      'contain-intrinsic-size only takes effect alongside content-visibility/contain: size, '
        + 'which a transcript row must not have — see cloudcli#495',
    );
  }
});
