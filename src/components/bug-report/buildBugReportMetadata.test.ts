import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project, ProjectSession } from '../../types/app';

import { buildBugReportMetadata } from './buildBugReportMetadata';

const project: Project = {
  projectId: '7',
  displayName: 'cloudcli',
  fullPath: '/home/user/repos/cloudcli',
};

const session: ProjectSession = {
  id: 'sess-abc',
  provider: 'claude',
};

const environment = {
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
  language: 'en-US',
  timezone: 'America/Chicago',
  viewport: '1440×900',
  route: '/chat?tab=files',
};

test('buildBugReportMetadata collects the full picture when everything is present', () => {
  const metadata = buildBugReportMetadata({
    appVersion: '1.36.3',
    serverVersion: '1.36.2',
    activeTab: 'chat',
    project,
    session,
    environment,
  });

  assert.deepEqual(metadata, {
    appVersion: '1.36.3',
    serverVersion: '1.36.2',
    provider: 'claude',
    sessionId: 'sess-abc',
    projectName: 'cloudcli',
    projectPath: '/home/user/repos/cloudcli',
    activeTab: 'chat',
    route: '/chat?tab=files',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    viewport: '1440×900',
    language: 'en-US',
    timezone: 'America/Chicago',
  });
});

test('buildBugReportMetadata omits absent fields instead of emitting undefined', () => {
  const metadata = buildBugReportMetadata({
    appVersion: '1.36.3',
    serverVersion: null,
    activeTab: 'files',
    project: null,
    session: null,
    environment: {},
  });

  assert.deepEqual(metadata, { appVersion: '1.36.3', activeTab: 'files' });
  assert.ok(!('sessionId' in metadata));
  assert.ok(!('serverVersion' in metadata));
});

test('buildBugReportMetadata prefers `path` over `fullPath` for the project location', () => {
  const metadata = buildBugReportMetadata({
    appVersion: '1.0.0',
    activeTab: 'chat',
    project: { ...project, path: '/mnt/work/cloudcli' },
    session: null,
    environment: {},
  });

  assert.equal(metadata.projectPath, '/mnt/work/cloudcli');
});

test('buildBugReportMetadata falls back to the internal provider tag', () => {
  const metadata = buildBugReportMetadata({
    appVersion: '1.0.0',
    activeTab: 'chat',
    project: null,
    session: { id: 's1', __provider: 'codex' },
    environment: {},
  });

  assert.equal(metadata.provider, 'codex');
});

test('buildBugReportMetadata treats blank strings as absent', () => {
  const metadata = buildBugReportMetadata({
    appVersion: '1.0.0',
    activeTab: 'chat',
    project: { ...project, displayName: '   ' },
    session: { id: '  ' },
    environment: { userAgent: '', route: '  ' },
  });

  assert.ok(!('projectName' in metadata));
  assert.ok(!('sessionId' in metadata));
  assert.ok(!('userAgent' in metadata));
  assert.ok(!('route' in metadata));
});
