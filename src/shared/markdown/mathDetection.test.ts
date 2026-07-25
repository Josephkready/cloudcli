import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { containsMath, looksLikeMathBody, stripCodeSpans } from './mathDetection';

describe('containsMath — real LaTeX', () => {
  const positives: Array<[string, string]> = [
    ['display math', 'Here it is:\n\n$$x^2$$\n'],
    ['multi-line display math', '$$\n\\frac{a}{b} = c\n$$'],
    ['inline superscript', 'The area is $x^2$ square units.'],
    ['inline command', 'Let $\\alpha$ be the learning rate.'],
    ['inline fraction', 'We get $\\frac{1}{2}$ of the total.'],
    ['inline equation', 'Einstein wrote $E=mc^2$ on the board.'],
    ['inline sum with operator and letter', 'Then $a + b$ is the answer.'],
    ['subscripted variable', 'Take $a_1$ and continue.'],
    ['bare single-letter symbol', 'For each $n$ in the sequence.'],
    ['math after a rejected currency candidate', 'It costs $5 and solves $x^2$ nicely.'],
    ['braces', 'Define $\\{1, 2, 3\\}$ as the set.'],
    // The display pair is malformed (its body holds a stray `$`), but the inline
    // pair left inside it is real, so the scanner must still find it.
    ['inline math left inside a malformed display pair', '$$a$x^2$$'],
  ];

  for (const [name, markdown] of positives) {
    it(`detects ${name}`, () => {
      assert.equal(containsMath(markdown), true, markdown);
    });
  }
});

describe('containsMath — prose that merely contains dollars', () => {
  const negatives: Array<[string, string]> = [
    ['no dollar at all', 'A perfectly ordinary sentence about TypeScript.'],
    ['empty string', ''],
    ['single price', 'The plan costs $5.'],
    // remark-math parses this as inline math with the body `5 and ` today, which
    // is exactly the false positive the naive `/\$\$?[^$]/` test would keep.
    ['two prices', 'It costs $5 and $10 total.'],
    ['price list', 'Pay $5, get $10, save $20.'],
    ['currency range', 'A US$100-$200 range is typical.'],
    ['trailing dollar', 'Everything after the $ is ignored.'],
    ['escaped dollars', 'Literal \\$x\\$ should stay literal.'],
    ['prices across lines', 'First it was $5\nthen it became $10.'],
    // A `$$…$$` whose body carries a stray `$` is malformed rather than display
    // math, and the `$$` delimiters it leaves behind must not then be re-read as
    // inline openers.
    ['stray display delimiters around price prose', '$$5 and $10 total$$'],
  ];

  for (const [name, markdown] of negatives) {
    it(`ignores ${name}`, () => {
      assert.equal(containsMath(markdown), false, markdown);
    });
  }
});

describe('containsMath — code is never math', () => {
  it('ignores shell variables in a fenced block', () => {
    const markdown = ['Run this:', '', '```bash', 'echo ${HOME}$PATH', 'cd $HOME', '```'].join('\n');
    assert.equal(containsMath(markdown), false);
  });

  it('ignores an unterminated fenced block (streaming output)', () => {
    const markdown = ['```bash', 'export A=${B}$C'].join('\n');
    assert.equal(containsMath(markdown), false);
  });

  it('ignores tilde fences', () => {
    const markdown = ['~~~sh', 'echo ${X}$Y', '~~~'].join('\n');
    assert.equal(containsMath(markdown), false);
  });

  it('ignores inline code spans', () => {
    assert.equal(containsMath('Use `${FOO}$BAR` in the template.'), false);
  });

  it('still finds math outside a fenced block', () => {
    const markdown = ['```js', 'const a = 1;', '```', '', 'and $x^2$ afterwards'].join('\n');
    assert.equal(containsMath(markdown), true);
  });
});

describe('stripCodeSpans', () => {
  it('removes a fenced block but keeps surrounding prose', () => {
    const stripped = stripCodeSpans(['before', '```', 'echo $HOME', '```', 'after'].join('\n'));
    assert.match(stripped, /before/);
    assert.match(stripped, /after/);
    assert.ok(!stripped.includes('$HOME'));
  });

  it('removes inline code', () => {
    assert.ok(!stripCodeSpans('a `$x$` b').includes('$x$'));
  });

  it('handles double-backtick spans containing a backtick', () => {
    assert.ok(!stripCodeSpans('a ``$x` $`` b').includes('$x'));
  });
});

describe('looksLikeMathBody', () => {
  it('rejects bodies padded with whitespace', () => {
    assert.equal(looksLikeMathBody(' x^2'), false);
    assert.equal(looksLikeMathBody('x^2 '), false);
    assert.equal(looksLikeMathBody(''), false);
  });

  it('accepts strong signals even without letters', () => {
    assert.equal(looksLikeMathBody('2^3'), true);
    assert.equal(looksLikeMathBody('\\pi'), true);
  });

  it('requires a letter alongside a weak operator', () => {
    assert.equal(looksLikeMathBody('5*'), false);
    assert.equal(looksLikeMathBody('a*b'), true);
  });

  it('rejects bare numbers but accepts bare symbols', () => {
    assert.equal(looksLikeMathBody('100'), false);
    assert.equal(looksLikeMathBody('x'), true);
    assert.equal(looksLikeMathBody('a1'), true);
    assert.equal(looksLikeMathBody('5 and '), false);
  });
});
