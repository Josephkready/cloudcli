import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mermaidDiagramId, mermaidInitConfig, mermaidTheme } from './mermaidConfig';

/*
 * `mermaidConfig` is deliberately free of any runtime mermaid import, which is
 * both what keeps the engine out of the entry chunk and what makes this file
 * runnable under `tsx --test` (which cannot load mermaid's ESM build at all).
 */

describe('mermaidTheme', () => {
  it('follows the app theme', () => {
    assert.equal(mermaidTheme(true), 'dark');
    assert.equal(mermaidTheme(false), 'default');
  });
});

describe('mermaidDiagramId', () => {
  it('strips the colons React useId() produces', () => {
    // `:r7:` would be spliced straight into mermaid's own CSS selectors, where
    // the colons make the selector invalid and mermaid throws.
    assert.equal(mermaidDiagramId(':r7:'), 'mermaid-r7');
  });

  it('keeps characters that are already safe', () => {
    assert.equal(mermaidDiagramId('abc_123-XYZ'), 'mermaid-abc_123-XYZ');
  });

  it('falls back to a constant when nothing safe survives', () => {
    assert.equal(mermaidDiagramId('::::'), 'mermaid-diagram');
    assert.equal(mermaidDiagramId(''), 'mermaid-diagram');
  });

  it('always produces a valid CSS identifier', () => {
    for (const seed of [':r1a: b/c.d', '«?»', ':R2H1:', 'éè']) {
      assert.match(mermaidDiagramId(seed), /^[a-zA-Z_-][a-zA-Z0-9_-]*$/, `seed ${seed}`);
    }
  });
});

describe('mermaidInitConfig', () => {
  it('never lets mermaid scan the document on its own', () => {
    assert.equal(mermaidInitConfig(false).startOnLoad, false);
  });

  it('keeps the strict security posture for model-authored source', () => {
    assert.equal(mermaidInitConfig(false).securityLevel, 'strict');
  });

  it('suppresses mermaid drawing its own error graphic', () => {
    // Invalid diagrams fall back to the code block. If mermaid were allowed to
    // render its "Syntax error in text" bomb it would inject that into the
    // document as well, on top of the fallback.
    assert.equal(mermaidInitConfig(false).suppressErrorRendering, true);
  });

  it('carries the theme matching the app mode', () => {
    assert.equal(mermaidInitConfig(true).theme, 'dark');
    assert.equal(mermaidInitConfig(false).theme, 'default');
  });

  it('turns off fit-to-container sizing for every diagram type', () => {
    // With mermaid's default `useMaxWidth: true` a wide diagram is squeezed
    // down to the chat column and becomes unreadable. Natural width + a
    // scrolling container is the trade this app makes instead.
    const config = mermaidInitConfig(false) as Record<string, { useMaxWidth?: boolean }>;
    // Every key the config sets, not a sample of them: they all point at one
    // shared constant, so a typo in a key name is the failure this can catch,
    // and only an exhaustive list catches it.
    const sized = [
      'flowchart',
      'sequence',
      'class',
      'state',
      'er',
      'gantt',
      'journey',
      'pie',
      'gitGraph',
      'mindmap',
      'timeline',
      'requirement',
    ];

    for (const key of sized) {
      assert.equal(config[key]?.useMaxWidth, false, `${key} should keep its natural width`);
    }
  });
});
