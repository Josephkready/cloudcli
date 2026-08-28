import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createMermaidFenceGate,
  isMermaidClassName,
  isMermaidLanguage,
  scanFences,
} from './mermaidFences';

/*
 * The two decisions that separate "renders a diagram" from "mangles a message":
 * whether a fence is mermaid at all, and whether it has finished arriving.
 *
 * Both are pure string work over the markdown source, which is why they live in
 * a module of their own and are tested here rather than through the DOM.
 */

describe('isMermaidLanguage', () => {
  it('accepts exactly the mermaid info string', () => {
    assert.equal(isMermaidLanguage('mermaid'), true);
    assert.equal(isMermaidLanguage('MERMAID'), true);
    assert.equal(isMermaidLanguage('  mermaid  '), true);
  });

  it('rejects languages that merely start with mermaid', () => {
    // The reason this matters: `Markdown.tsx` derives its language badge with
    // `/language-(\w+)/`, and `\w` stops at the hyphen — so `mermaid-something`
    // reports itself as `mermaid` unless something says otherwise.
    assert.equal(isMermaidLanguage('mermaidjs'), false);
    assert.equal(isMermaidLanguage('mermaid-something'), false);
    assert.equal(isMermaidLanguage('mermaid2'), false);
  });

  it('rejects other languages and missing values', () => {
    assert.equal(isMermaidLanguage('ts'), false);
    assert.equal(isMermaidLanguage(''), false);
    assert.equal(isMermaidLanguage(undefined), false);
    assert.equal(isMermaidLanguage(null), false);
  });
});

describe('isMermaidClassName', () => {
  it('detects the class react-markdown puts on a mermaid fence', () => {
    assert.equal(isMermaidClassName(['language-mermaid']), true);
    assert.equal(isMermaidClassName('language-mermaid'), true);
    assert.equal(isMermaidClassName('hljs language-mermaid'), true);
    assert.equal(isMermaidClassName(['hljs', 'language-mermaid']), true);
  });

  it('does not match a longer language that starts with mermaid', () => {
    assert.equal(isMermaidClassName(['language-mermaidjs']), false);
    assert.equal(isMermaidClassName(['language-mermaid-something']), false);
    assert.equal(isMermaidClassName('language-mermaidjs'), false);
  });

  it('is false for other languages, plain fences and junk', () => {
    assert.equal(isMermaidClassName(['language-ts']), false);
    assert.equal(isMermaidClassName(undefined), false);
    assert.equal(isMermaidClassName(null), false);
    assert.equal(isMermaidClassName(42), false);
    assert.equal(isMermaidClassName([null, 7]), false);
  });
});

describe('scanFences', () => {
  it('reads a closed fence with its language and body', () => {
    const markdown = ['before', '```mermaid', 'graph TD', '  A --> B', '```', 'after'].join('\n');

    assert.deepEqual(scanFences(markdown), [
      { language: 'mermaid', body: 'graph TD\n  A --> B', closed: true },
    ]);
  });

  it('flags an unterminated fence as unclosed and keeps what arrived', () => {
    const markdown = ['Here is a diagram:', '```mermaid', 'graph TD', '  A -->'].join('\n');

    assert.deepEqual(scanFences(markdown), [
      { language: 'mermaid', body: 'graph TD\n  A -->', closed: false },
    ]);
  });

  it('handles several fences, including a mix of languages', () => {
    const markdown = [
      '```ts',
      'const a = 1;',
      '```',
      'text',
      '```mermaid',
      'graph TD',
      '```',
    ].join('\n');

    assert.deepEqual(scanFences(markdown), [
      { language: 'ts', body: 'const a = 1;', closed: true },
      { language: 'mermaid', body: 'graph TD', closed: true },
    ]);
  });

  it('takes the first word of the info string as the language', () => {
    assert.deepEqual(scanFences('```mermaid title="flow"\ngraph TD\n```'), [
      { language: 'mermaid', body: 'graph TD', closed: true },
    ]);
  });

  it('supports tilde fences and does not let one close a backtick fence', () => {
    assert.deepEqual(scanFences('~~~mermaid\ngraph TD\n~~~'), [
      { language: 'mermaid', body: 'graph TD', closed: true },
    ]);
    assert.deepEqual(scanFences('```mermaid\ngraph TD\n~~~'), [
      { language: 'mermaid', body: 'graph TD\n~~~', closed: false },
    ]);
  });

  it('requires the closer to be at least as long as the opener', () => {
    assert.deepEqual(scanFences('````mermaid\ngraph TD\n```\nstill inside\n````'), [
      { language: 'mermaid', body: 'graph TD\n```\nstill inside', closed: true },
    ]);
  });

  it('dedents the body by the opener indent', () => {
    assert.deepEqual(scanFences('  ```mermaid\n    graph TD\n  ```'), [
      { language: 'mermaid', body: '  graph TD', closed: true },
    ]);
  });

  it('ignores a single-line inline span that only looks like a fence', () => {
    // CommonMark: a backtick fence's info string may not contain a backtick.
    assert.deepEqual(scanFences('text ```mermaid``` more'), []);
  });

  it('returns nothing for markdown with no fences at all', () => {
    assert.deepEqual(scanFences('just prose, `inline code`, and a $x$ or two'), []);
    assert.deepEqual(scanFences(''), []);
  });
});

describe('createMermaidFenceGate', () => {
  const closedDiagram = ['```mermaid', 'graph TD', '  A --> B', '```'].join('\n');

  it('lets a closed mermaid fence render', () => {
    const gate = createMermaidFenceGate(closedDiagram);
    // react-markdown hands the renderer the body plus a trailing newline.
    assert.equal(gate('graph TD\n  A --> B\n'), true);
  });

  it('holds back a fence that is still streaming', () => {
    // The exact shape of a diagram half-way through a streamed reply: no
    // closing fence yet, so the source is a prefix of the real diagram.
    const streaming = ['Sure, here it is:', '```mermaid', 'graph TD', '  A --> B'].join('\n');
    const gate = createMermaidFenceGate(streaming);

    assert.equal(gate('graph TD\n  A --> B\n'), false);
  });

  it('releases the same diagram once its closing fence arrives', () => {
    const body = 'graph TD\n  A --> B\n';
    assert.equal(createMermaidFenceGate('```mermaid\ngraph TD\n  A --> B')(body), false);
    assert.equal(createMermaidFenceGate(closedDiagram)(body), true);
  });

  it('holds back only the unfinished fence when a message has several', () => {
    const markdown = [
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
      'and another:',
      '```mermaid',
      'sequenceDiagram',
    ].join('\n');
    const gate = createMermaidFenceGate(markdown);

    assert.equal(gate('graph TD\n  A --> B\n'), true);
    assert.equal(gate('sequenceDiagram\n'), false);
  });

  it('treats an identical body as renderable once any copy of it has closed', () => {
    const markdown = ['```mermaid', 'graph TD', '```', '```mermaid', 'graph TD'].join('\n');

    assert.equal(createMermaidFenceGate(markdown)('graph TD\n'), true);
  });

  it('ignores non-mermaid fences entirely, closed or not', () => {
    const gate = createMermaidFenceGate('```ts\nconst a = 1;');
    // An unclosed *TypeScript* fence must not hold anything back — the gate is
    // only ever consulted for mermaid blocks, and must never answer `false` on
    // the strength of some other language's fence body.
    assert.equal(gate('const a = 1;\n'), true);
  });

  it('renders a body it never saw in the source', () => {
    // Defaulting to `true` keeps a scanner miss cheap: at worst one parse fails
    // and the source is shown, rather than diagrams silently never appearing.
    assert.equal(createMermaidFenceGate('no fences here')('graph TD\n'), true);
  });

  it('holds back an empty unterminated fence', () => {
    assert.equal(createMermaidFenceGate('```mermaid')(''), false);
  });
});
