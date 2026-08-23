import assert from 'node:assert/strict';
import test from 'node:test';

import { hasLaunchIntent, parseLaunchParams, stripLaunchParams } from './launchParams';

/*
 * Launch intents from the manifest's `shortcuts` and `share_target` (issue
 * #370). Both arrive as query parameters on a cold start, and both are one-shot
 * — acting on them twice is a visible bug (a conversation reset the user did not
 * ask for, or the same share inserted again), so the stripping is as load-
 * bearing as the parsing.
 */

test('a plain launch asks for nothing', () => {
  const intent = parseLaunchParams('');
  assert.equal(intent.newConversation, false);
  assert.equal(intent.sharedText, null);
  assert.equal(hasLaunchIntent(intent), false);
});

test('the shortcut requests a new conversation', () => {
  assert.equal(parseLaunchParams('?new=1').newConversation, true);
  // Bare presence counts — a shortcut URL need not carry a value.
  assert.equal(parseLaunchParams('?new').newConversation, true);
});

test('an explicit falsey value does not start a conversation', () => {
  // A round-tripped or hand-edited URL must not surprise anyone.
  assert.equal(parseLaunchParams('?new=0').newConversation, false);
  assert.equal(parseLaunchParams('?new=false').newConversation, false);
});

test('shared text alone is passed through', () => {
  assert.equal(parseLaunchParams('?share_text=hello%20there').sharedText, 'hello there');
});

test('a shared link with no text becomes the URL', () => {
  assert.equal(
    parseLaunchParams('?share_url=https%3A%2F%2Fexample.com%2Fa').sharedText,
    'https://example.com/a',
  );
});

test('title, text and url are joined in reading order', () => {
  const intent = parseLaunchParams(
    '?share_title=A%20post&share_text=Some%20body&share_url=https%3A%2F%2Fexample.com',
  );
  assert.equal(intent.sharedText, 'A post\n\nSome body\n\nhttps://example.com');
});

// Senders disagree about which field carries what; several send a title that is
// just the first line of the text, and appending both reads as a stutter.
test('a title that merely repeats the text is dropped', () => {
  assert.equal(parseLaunchParams('?share_title=Same&share_text=Same').sharedText, 'Same');
  assert.equal(
    parseLaunchParams('?share_title=Same&share_text=Same%20plus%20more').sharedText,
    'Same plus more',
  );
});

test('a url already inside the text is not appended twice', () => {
  const intent = parseLaunchParams(
    '?share_text=look%20at%20https%3A%2F%2Fexample.com%20ok&share_url=https%3A%2F%2Fexample.com',
  );
  assert.equal(intent.sharedText, 'look at https://example.com ok');
});

test('blank and whitespace-only shares are nothing', () => {
  assert.equal(parseLaunchParams('?share_text=%20%20').sharedText, null);
  assert.equal(parseLaunchParams('?share_title=&share_text=&share_url=').sharedText, null);
});

test('a share and a shortcut can arrive together', () => {
  const intent = parseLaunchParams('?new=1&share_text=hi');
  assert.equal(intent.newConversation, true);
  assert.equal(intent.sharedText, 'hi');
  assert.equal(hasLaunchIntent(intent), true);
});

test('stripping removes every launch parameter', () => {
  assert.equal(
    stripLaunchParams('/?new=1&share_title=a&share_text=b&share_url=c'),
    '/',
  );
});

test('stripping preserves unrelated parameters and the hash', () => {
  // This runs against the real address bar, so eating someone else's state
  // would be a silent, hard-to-attribute bug.
  assert.equal(
    stripLaunchParams('/session/abc?tab=files&new=1#top'),
    '/session/abc?tab=files#top',
  );
});

test('stripping a URL with no launch parameters changes nothing', () => {
  assert.equal(stripLaunchParams('/session/abc?tab=files'), '/session/abc?tab=files');
});
