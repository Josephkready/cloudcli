import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_BROWSE_COMMON_DIRS,
  annotateRepositoryFlags,
  buildBrowseSuggestions,
  parseBrowseCommonDirs,
} from '@/shared/browse-suggestions.js';

type Dir = { name: string; path: string; type: 'directory' };

const dir = (name: string): Dir => ({ name, path: `/root/${name}`, type: 'directory' });

// Input is already hidden-last + alpha sorted, matching how the endpoint hands
// directories to the suggestion builder.
const sortedDirs: Dir[] = [dir('alpha'), dir('beta'), dir('Documents'), dir('zeta')];

//----------------- parseBrowseCommonDirs ------------
test('parseBrowseCommonDirs returns the default list when the value is undefined (unset)', () => {
  assert.deepEqual(
    parseBrowseCommonDirs(undefined),
    [...DEFAULT_BROWSE_COMMON_DIRS],
  );
});

test('parseBrowseCommonDirs returns an empty list when the value is an empty string (disabled)', () => {
  assert.deepEqual(parseBrowseCommonDirs(''), []);
});

test('parseBrowseCommonDirs returns an empty list when the value is only whitespace/commas', () => {
  assert.deepEqual(parseBrowseCommonDirs('  , ,, '), []);
});

test('parseBrowseCommonDirs splits on commas, trims entries, and drops blanks', () => {
  assert.deepEqual(
    parseBrowseCommonDirs(' Projects , repos ,, code '),
    ['Projects', 'repos', 'code'],
  );
});

//----------------- buildBrowseSuggestions ------------
test('at the workspace root with a non-empty common-dirs list, matching common dirs sort to the front', () => {
  const suggestions = buildBrowseSuggestions(sortedDirs, ['Documents', 'zeta'], true);
  assert.deepEqual(
    suggestions.map((entry) => entry.name),
    // Documents + zeta are promoted (preserving the input order among themselves),
    // the rest follow in their original order.
    ['Documents', 'zeta', 'alpha', 'beta'],
  );
});

test('at the workspace root, only common dirs that actually exist are promoted', () => {
  const suggestions = buildBrowseSuggestions(sortedDirs, ['Desktop', 'Documents'], true);
  assert.deepEqual(
    suggestions.map((entry) => entry.name),
    ['Documents', 'alpha', 'beta', 'zeta'],
  );
});

test('an empty/disabled common-dirs list leaves the input dirs unchanged, even at the workspace root', () => {
  const suggestions = buildBrowseSuggestions(sortedDirs, [], true);
  assert.deepEqual(
    suggestions.map((entry) => entry.name),
    ['alpha', 'beta', 'Documents', 'zeta'],
  );
});

test('when NOT at the workspace root, the common-dirs list is never applied', () => {
  const suggestions = buildBrowseSuggestions(sortedDirs, ['Documents', 'zeta'], false);
  assert.deepEqual(
    suggestions.map((entry) => entry.name),
    ['alpha', 'beta', 'Documents', 'zeta'],
  );
});

test('buildBrowseSuggestions handles an empty directories input at the workspace root', () => {
  assert.deepEqual(buildBrowseSuggestions([], ['Documents'], true), []);
});

test('buildBrowseSuggestions returns a new array and does not mutate the input', () => {
  const input = [...sortedDirs];
  const suggestions = buildBrowseSuggestions(input, ['Documents'], true);
  assert.notEqual(suggestions, input);
  assert.deepEqual(
    input.map((entry) => entry.name),
    ['alpha', 'beta', 'Documents', 'zeta'],
  );
});

//----------------- annotateRepositoryFlags (#309) ------------
test('annotateRepositoryFlags tags each entry with the predicate result', async () => {
  const annotated = await annotateRepositoryFlags(
    [dir('cloudcli'), dir('scratch')],
    async (dirPath) => dirPath === '/root/cloudcli',
  );

  assert.deepEqual(
    annotated.map(({ name, isRepository }) => ({ name, isRepository })),
    [
      { name: 'cloudcli', isRepository: true },
      { name: 'scratch', isRepository: false },
    ],
  );
});

test('annotateRepositoryFlags preserves the incoming order and the other fields', async () => {
  const annotated = await annotateRepositoryFlags(sortedDirs, async () => true);

  assert.deepEqual(
    annotated.map((entry) => entry.name),
    ['alpha', 'beta', 'Documents', 'zeta'],
  );
  assert.equal(annotated[0].path, '/root/alpha');
  assert.equal(annotated[0].type, 'directory');
});

test('annotateRepositoryFlags does not mutate the input entries', async () => {
  const input = [dir('alpha')];
  const annotated = await annotateRepositoryFlags(input, async () => true);

  assert.notEqual(annotated[0], input[0]);
  assert.equal('isRepository' in input[0], false);
});

test('annotateRepositoryFlags handles an empty listing', async () => {
  assert.deepEqual(await annotateRepositoryFlags([], async () => true), []);
});

test('DEFAULT_BROWSE_COMMON_DIRS preserves the historical hardcoded picker list', () => {
  assert.deepEqual(
    [...DEFAULT_BROWSE_COMMON_DIRS],
    ['Desktop', 'Documents', 'Projects', 'Development', 'Dev', 'Code', 'workspace'],
  );
});
