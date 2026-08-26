import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_BUG_REPORT_REPO,
  MAX_DESCRIPTION_LENGTH,
  MAX_METADATA_VALUE_LENGTH,
  MAX_TITLE_LENGTH,
  buildIssueBody,
  buildIssueTitle,
  describeDescriptionRejection,
  formatMetadataTable,
  normalizeDescription,
  normalizeMetadataValue,
  resolveBugReportRepo,
} from './bug-report.js';

test('normalizeDescription trims and accepts real text', () => {
  assert.equal(normalizeDescription('  the tab bar overflows  '), 'the tab bar overflows');
});

test('normalizeDescription rejects blank, non-string and oversized input', () => {
  assert.equal(normalizeDescription('   \n\t '), null);
  assert.equal(normalizeDescription(''), null);
  assert.equal(normalizeDescription(undefined), null);
  assert.equal(normalizeDescription(42), null);
  assert.equal(normalizeDescription('x'.repeat(MAX_DESCRIPTION_LENGTH)), 'x'.repeat(MAX_DESCRIPTION_LENGTH));
  assert.equal(normalizeDescription('x'.repeat(MAX_DESCRIPTION_LENGTH + 1)), null);
});

test('buildIssueTitle uses the first non-empty line', () => {
  assert.equal(buildIssueTitle('\n\n  Sidebar scroll jumps\nmore detail here'), 'Bug: Sidebar scroll jumps');
});

test('buildIssueTitle truncates long lines on a word boundary', () => {
  const line = 'the session tab bar keeps scrolling back to the start whenever a message finishes streaming';
  const title = buildIssueTitle(line);

  assert.ok(title.length <= MAX_TITLE_LENGTH + 'Bug: '.length);
  assert.ok(title.endsWith('…'));
  // Word-boundary cut: no partial word before the ellipsis.
  assert.ok(line.startsWith(title.slice('Bug: '.length, -1)));
});

test('buildIssueTitle hard-cuts a single unbroken token', () => {
  const title = buildIssueTitle('x'.repeat(200));
  assert.equal(title, `Bug: ${'x'.repeat(MAX_TITLE_LENGTH - 1)}…`);
});

test('normalizeMetadataValue flattens whitespace and escapes table pipes', () => {
  assert.equal(normalizeMetadataValue(' Mozilla/5.0\n (X11)  '), 'Mozilla/5.0 (X11)');
  assert.equal(normalizeMetadataValue('a|b'), 'a\\|b');
  assert.equal(normalizeMetadataValue(7), '7');
  assert.equal(normalizeMetadataValue(false), 'false');
});

test('normalizeMetadataValue drops empty and structured values', () => {
  assert.equal(normalizeMetadataValue('   '), null);
  assert.equal(normalizeMetadataValue(null), null);
  assert.equal(normalizeMetadataValue(undefined), null);
  assert.equal(normalizeMetadataValue({ nested: true }), null);
  assert.equal(normalizeMetadataValue(['a']), null);
});

test('normalizeMetadataValue caps very long values', () => {
  const value = normalizeMetadataValue('y'.repeat(MAX_METADATA_VALUE_LENGTH + 50));
  assert.equal(value?.length, MAX_METADATA_VALUE_LENGTH);
  assert.ok(value?.endsWith('…'));
});

test('formatMetadataTable renders known fields in declared order and drops unknown ones', () => {
  const table = formatMetadataTable({
    sessionId: 'abc-123',
    appVersion: '1.36.3',
    // @ts-expect-error — unknown keys must not be echoed into a public issue
    secretToken: 'ghp_do_not_leak',
  });

  assert.equal(table, [
    '| Field | Value |',
    '| --- | --- |',
    '| App version | `1.36.3` |',
    '| Session ID | `abc-123` |',
  ].join('\n'));
  assert.ok(!table.includes('ghp_do_not_leak'));
});

test('formatMetadataTable returns empty string when nothing survives', () => {
  assert.equal(formatMetadataTable({}), '');
  assert.equal(formatMetadataTable({ sessionId: '  ', provider: null }), '');
});

test('buildIssueBody keeps the description verbatim and appends the marker', () => {
  const body = buildIssueBody('It **broke**\n\n- step one', { provider: 'claude' });

  assert.ok(body.includes('### What happened'));
  assert.ok(body.includes('It **broke**\n\n- step one'));
  assert.ok(body.includes('| Provider | `claude` |'));
  assert.ok(body.includes('CloudCLI in-app bug reporter'));
});

test('describeDescriptionRejection tells a long paste apart from an empty one', () => {
  assert.match(describeDescriptionRejection('x'.repeat(MAX_DESCRIPTION_LENGTH + 1)), /too long/);
  assert.match(describeDescriptionRejection(''), /describe the bug/);
  assert.match(describeDescriptionRejection('   '), /describe the bug/);
  assert.match(describeDescriptionRejection(undefined), /describe the bug/);
});

test('buildIssueBody omits the details section when there is no metadata', () => {
  const body = buildIssueBody('plain report', {});
  assert.ok(!body.includes('### Session details'));
});

test('resolveBugReportRepo honours a valid override and rejects junk', () => {
  assert.equal(resolveBugReportRepo({ BUG_REPORT_REPO: 'siteboon/claudecodeui' }), 'siteboon/claudecodeui');
  assert.equal(resolveBugReportRepo({}), DEFAULT_BUG_REPORT_REPO);
  assert.equal(resolveBugReportRepo({ BUG_REPORT_REPO: '  ' }), DEFAULT_BUG_REPORT_REPO);
  assert.equal(resolveBugReportRepo({ BUG_REPORT_REPO: 'not-a-repo' }), DEFAULT_BUG_REPORT_REPO);
  assert.equal(resolveBugReportRepo({ BUG_REPORT_REPO: 'owner/name; rm -rf /' }), DEFAULT_BUG_REPORT_REPO);
});
