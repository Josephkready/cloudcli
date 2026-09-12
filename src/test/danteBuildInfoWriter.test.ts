import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/*
 * Build-identity JSON writer (#458 follow-up).
 *
 * `scripts/write-build-info.sh` writes the git SHA + build time the server parses and
 * serves from /health. It used to be an interpolating shell heredoc in dante-build.sh:
 *
 *     cat > ... <<EOF
 *     {"sha":"${VITE_BUILD_SHA}","built_at":"${VITE_BUILT_AT}"}
 *     EOF
 *
 * which would emit malformed JSON (or let a crafted value inject arbitrary JSON) the
 * moment either variable contained a double-quote, backslash or newline. These tests run
 * the real writer with hostile values and assert the output still parses and round-trips.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WRITER = join(ROOT, 'scripts', 'write-build-info.sh');
const DANTE_BUILD = join(ROOT, 'scripts', 'dante-build.sh');

const writeInfo = (sha: string, builtAt: string): unknown => {
  const dir = mkdtempSync(join(tmpdir(), 'build-info-'));
  const out = join(dir, 'build-info.json');
  try {
    execFileSync('bash', [WRITER, sha, builtAt, out], { stdio: 'pipe' });
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('write-build-info.sh — always emits valid JSON (#458 follow-up)', () => {
  it('writes a plain SHA and timestamp verbatim', () => {
    assert.deepEqual(writeInfo('abc1234', '2026-09-12T00:00:00Z'), {
      sha: 'abc1234',
      built_at: '2026-09-12T00:00:00Z',
    });
  });

  it('escapes a double-quote instead of breaking the JSON string', () => {
    const sha = 'a"b';
    assert.deepEqual(writeInfo(sha, 't'), { sha, built_at: 't' });
  });

  it('escapes a backslash instead of starting an escape sequence', () => {
    const sha = 'a\\b';
    assert.deepEqual(writeInfo(sha, 't'), { sha, built_at: 't' });
  });

  it('survives quotes, backslashes and newlines in either value', () => {
    const sha = 'a"b\\c\nd\te';
    const builtAt = '{"injected":true}\\\\';
    const parsed = writeInfo(sha, builtAt) as { sha: string; built_at: string };
    assert.deepEqual(parsed, { sha, built_at: builtAt });
    // A raw interpolation would have produced extra keys / failed to parse entirely.
    assert.deepEqual(Object.keys(parsed).sort(), ['built_at', 'sha']);
  });

  it('safely round-trips hostile strings with non-ASCII, emojis, control chars, and JSON injection attempts', () => {
    const hostileSha = 'rev-"491"\\test\r\n\t</script><script>alert("xss")</script> 🚀 café ñ 日本語';
    const hostileBuiltAt = '{"fake_key": "override", "injected": [1, 2, 3]}\\\\ \'" \n\t ⚡';
    const parsed = writeInfo(hostileSha, hostileBuiltAt) as { sha: string; built_at: string };
    assert.deepEqual(parsed, { sha: hostileSha, built_at: hostileBuiltAt });
    assert.deepEqual(Object.keys(parsed).sort(), ['built_at', 'sha']);
  });

  it('fails loudly when given the wrong number of arguments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'build-info-'));
    try {
      assert.throws(() =>
        execFileSync('bash', [WRITER, 'only-one-arg', join(dir, 'out.json')], { stdio: 'pipe' }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dante-build.sh — delegates identity writing to the JSON writer (#458 follow-up)', () => {
  it('no longer interpolates the values into a raw heredoc', () => {
    const script = readFileSync(DANTE_BUILD, 'utf8');
    assert.match(script, /write-build-info\.sh/);
    assert.doesNotMatch(script, /\{"sha":"\$\{VITE_BUILD_SHA\}/);
  });
});
