/**
 * Everything KaTeX, isolated into a chunk nothing imports statically.
 *
 * This module is only ever reached through `import('./mathRuntime')` in
 * `useMathPlugins`, which is what keeps `rehype-katex`, the KaTeX runtime, and
 * `katex.min.css` out of the entry chunk and out of the render-blocking
 * stylesheet (issue #269). Rollup emits the stylesheet as this chunk's own CSS
 * asset and Vite's preload helper injects the `<link>` before the chunk
 * executes, so the 59 KaTeX font files still resolve from `/assets/` exactly as
 * they did when the CSS was imported from `main.jsx`.
 *
 * Do not import this file from anywhere that is reachable statically from the
 * app entry — that would silently undo the split.
 */
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';

import 'katex/dist/katex.min.css';

export { rehypeKatex, remarkMath };
