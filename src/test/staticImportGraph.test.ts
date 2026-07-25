import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isTypeOnlyClause, parseStaticImports } from './staticImportGraph';

/*
 * The entry-chunk guard in `entryStaticImports.test.ts` is only worth what this
 * parser is worth: a walker that misses an import would pass the guard while
 * xterm quietly crept back into the boot path. These cases are the shapes that
 * actually appear in `src/` — notably `import { Value, type Type } from`, which
 * is what `useShellTerminal.ts` uses for the xterm addons.
 */

describe('parseStaticImports', () => {
  it('finds default, named and namespace imports', () => {
    const source = [
      "import React from 'react';",
      "import { useState } from 'react';",
      "import * as ReactDOM from 'react-dom';",
      "import Shell, { type ShellProps } from './Shell';",
    ].join('\n');

    assert.deepEqual(parseStaticImports(source), ['react', 'react', 'react-dom', './Shell']);
  });

  it('finds side-effect imports', () => {
    assert.deepEqual(parseStaticImports("import '@xterm/xterm/css/xterm.css';"), [
      '@xterm/xterm/css/xterm.css',
    ]);
  });

  it('finds multi-line import clauses', () => {
    const source = ['import {', '  FitAddon,', '  WebglAddon,', "} from '@xterm/addon-fit';"].join('\n');

    assert.deepEqual(parseStaticImports(source), ['@xterm/addon-fit']);
  });

  it('finds re-exports', () => {
    const source = ["export { default } from './ProjectCreationWizard';", "export * from './types';"].join('\n');

    assert.deepEqual(parseStaticImports(source), [
      './ProjectCreationWizard',
      './types',
    ]);
  });

  it('ignores dynamic imports — the whole point of the split', () => {
    const source = [
      "const Shell = lazy(() => import('./Shell'));",
      "const { default: DOMPurify } = await import('dompurify');",
    ].join('\n');

    assert.deepEqual(parseStaticImports(source), []);
  });

  it('ignores type-only imports and exports', () => {
    const source = [
      "import type { Terminal } from '@xterm/xterm';",
      "import { type FitAddon } from '@xterm/addon-fit';",
      "import { type A, type B } from '@codemirror/state';",
      "export type { Foo } from './types';",
    ].join('\n');

    assert.deepEqual(parseStaticImports(source), []);
  });

  it('keeps a mixed value/type clause — it still loads the module', () => {
    const source = "import { ClipboardAddon, type IClipboardProvider } from '@xterm/addon-clipboard';";

    assert.deepEqual(parseStaticImports(source), ['@xterm/addon-clipboard']);
  });

  it('ignores imports that only appear inside comments', () => {
    const source = [
      '/*',
      " * import { Terminal } from '@xterm/xterm';",
      ' */',
      "// import { EditorView } from '@codemirror/view';",
      "import { useState } from 'react';",
    ].join('\n');

    assert.deepEqual(parseStaticImports(source), ['react']);
  });
});

describe('isTypeOnlyClause', () => {
  it('treats a missing clause (side-effect import) as a value import', () => {
    assert.equal(isTypeOnlyClause(undefined), false);
  });

  it('recognises `type` prefixed clauses', () => {
    assert.equal(isTypeOnlyClause('type { Terminal }'), true);
    assert.equal(isTypeOnlyClause('{ type Terminal }'), true);
  });

  it('does not treat a value binding as type-only', () => {
    assert.equal(isTypeOnlyClause('{ Terminal }'), false);
    assert.equal(isTypeOnlyClause('{ Terminal, type ITerminalOptions }'), false);
    assert.equal(isTypeOnlyClause('Terminal'), false);
  });

  it('does not treat an empty brace clause as type-only', () => {
    assert.equal(isTypeOnlyClause('{}'), false);
  });
});
