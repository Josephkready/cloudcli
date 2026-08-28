import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MOCK_ASSISTANT_FRAME_COUNT,
  MOCK_ASSISTANT_TEXT,
  MOCK_ECHO_PREFIX,
  runMockAgentProvider,
} from '../mock-agent-provider.js';

/*
 * The mock provider's `echo:` seam.
 *
 * It exists so a browser e2e can choose what markdown lands in an ASSISTANT
 * bubble — user messages are deliberately rendered as plain text, so there is no
 * other way to get a ```mermaid fence in front of the chat renderer. That makes
 * it load-bearing for `e2e/mermaid.spec.ts`, and worth pinning here: if the
 * prefix stops working the e2e failure would look like a mermaid bug.
 *
 * The other half of the contract matters just as much — every spec that does NOT
 * use the prefix must keep seeing the fixed reply.
 */

/** Minimal stand-in for the writer contract every real provider drives. */
function collectingWriter() {
  const frames = [];
  return {
    frames,
    sessionIds: [],
    setSessionId(id) {
      this.sessionIds.push(id);
    },
    send(frame) {
      frames.push(frame);
    },
    text() {
      return frames
        .filter((frame) => frame.kind === 'text' && frame.role === 'assistant')
        .map((frame) => frame.content);
    },
  };
}

describe('runMockAgentProvider', () => {
  it('replies with the fixed transcript for an ordinary prompt', async () => {
    const writer = collectingWriter();

    await runMockAgentProvider('hello', {}, writer);

    assert.equal(writer.text().length, MOCK_ASSISTANT_FRAME_COUNT);
    assert.equal(writer.text().join(''), MOCK_ASSISTANT_TEXT);
  });

  it('echoes the remainder of an `echo:` prompt as one assistant frame', async () => {
    const markdown = '```mermaid\ngraph TD\n  A --> B\n```';
    const writer = collectingWriter();

    await runMockAgentProvider(`${MOCK_ECHO_PREFIX}${markdown}`, {}, writer);

    assert.deepEqual(writer.text(), [markdown]);
  });

  it('leaves the rest of the frame sequence intact when echoing', async () => {
    const writer = collectingWriter();

    await runMockAgentProvider(`${MOCK_ECHO_PREFIX}hi`, {}, writer);

    // Still a full run: a status frame, the reply, a token budget, a complete.
    assert.equal(writer.sessionIds.length, 1);
    assert.ok(writer.frames.some((frame) => frame.kind === 'status' && frame.text === 'thinking'));
    assert.ok(writer.frames.some((frame) => frame.kind === 'status' && frame.text === 'token_budget'));
    assert.equal(writer.frames.at(-1).kind, 'complete');
  });

  it('only treats the prefix as an instruction at the start of the prompt', async () => {
    const writer = collectingWriter();

    await runMockAgentProvider(`please ${MOCK_ECHO_PREFIX}nope`, {}, writer);

    assert.equal(writer.text().join(''), MOCK_ASSISTANT_TEXT);
  });

  it('tolerates a non-string message', async () => {
    const writer = collectingWriter();

    await runMockAgentProvider(undefined, {}, writer);

    assert.equal(writer.text().join(''), MOCK_ASSISTANT_TEXT);
  });
});
