import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_VAPID_SUBJECT, resolveVapidSubject } from './vapid-keys.js';

function captureWarnings(run) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    return { value: run(), warnings };
  } finally {
    console.warn = original;
  }
}

test('VAPID subject defaults to https://thedante.net when unset or blank', () => {
  assert.equal(DEFAULT_VAPID_SUBJECT, 'https://thedante.net');
  for (const raw of [undefined, '', '   ']) {
    const { value, warnings } = captureWarnings(() => resolveVapidSubject(raw));
    assert.equal(value, DEFAULT_VAPID_SUBJECT);
    assert.equal(warnings.length, 0);
  }
});

test('VAPID subject reads process.env.VAPID_SUBJECT by default', () => {
  const previous = process.env.VAPID_SUBJECT;
  process.env.VAPID_SUBJECT = 'https://example.com';
  try {
    assert.equal(resolveVapidSubject(), 'https://example.com');
  } finally {
    if (previous === undefined) delete process.env.VAPID_SUBJECT;
    else process.env.VAPID_SUBJECT = previous;
  }
});

test('VAPID subject accepts https URLs and public mailto addresses', () => {
  for (const raw of ['https://example.com', 'https://push.example.org/contact', 'mailto:ops@example.com']) {
    const { value, warnings } = captureWarnings(() => resolveVapidSubject(raw));
    assert.equal(value, raw);
    assert.equal(warnings.length, 0);
  }
  assert.equal(resolveVapidSubject('  https://example.com  '), 'https://example.com');
});

test('VAPID subject rejects .local / localhost hosts and bad schemes (#496)', () => {
  const invalid = [
    'mailto:noreply@cloudcli.local',
    'mailto:noreply@CLOUDCLI.LOCAL.',
    'mailto:admin@localhost',
    'https://localhost',
    'https://localhost:3001',
    'https://app.localhost',
    'https://cloudcli.local',
    'http://example.com',
    'example.com',
    'mailto:',
    'mailto:no-at-sign',
    'ftp://example.com',
  ];
  for (const raw of invalid) {
    const { value, warnings } = captureWarnings(() => resolveVapidSubject(raw));
    assert.equal(value, DEFAULT_VAPID_SUBJECT, `expected fallback for ${raw}`);
    assert.equal(warnings.length, 1, `expected a warning for ${raw}`);
  }
});
