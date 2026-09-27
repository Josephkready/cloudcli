import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import type { ProviderSkillSource } from '@/shared/types.js';

import { SkillsProvider } from './skills.provider.js';

// SkillsProvider is abstract — its two required hooks (getSkillSources /
// getGlobalSkillSource) are provided by a tiny concrete test double backed by
// real temp directories, exercising the shared listSkills/addSkills/removeSkill
// logic (the file's actual behavior) rather than any provider-specific
// discovery quirks. All I/O is real (temp dirs), matching the surrounding
// convention of using scratch directories instead of mocking fs.
class TestSkillsProvider extends SkillsProvider {
  sources: ProviderSkillSource[] = [];
  globalSource: ProviderSkillSource | null = null;

  constructor() {
    super('claude');
  }

  protected async getSkillSources(): Promise<ProviderSkillSource[]> {
    return this.sources;
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource | null> {
    return this.globalSource;
  }
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join('/var/tmp', 'skills-provider-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('listSkills: discovers SKILL.md files across sources and skips malformed ones', async () => {
  await withTempDir(async (root) => {
    const globalDir = path.join(root, 'global');
    const projectDir = path.join(root, 'project');
    await mkdir(path.join(globalDir, 'good-skill'), { recursive: true });
    await mkdir(path.join(globalDir, 'bad-skill'), { recursive: true });
    await mkdir(projectDir, { recursive: true });

    await writeFile(
      path.join(globalDir, 'good-skill', 'SKILL.md'),
      '---\nname: good-skill\ndescription: A good skill\n---\nBody',
      'utf8',
    );
    // Malformed YAML frontmatter (not merely a missing `name` field, which
    // falls back to the directory name rather than throwing) is what actually
    // exercises listSkills' per-skill try/catch — a real parse failure from
    // gray-matter/js-yaml, independent of file permissions (a chmod-based
    // "unreadable" file doesn't work here: the local-ci container runs as
    // root, which ignores permission bits entirely). It must not let one
    // broken skill hide the others.
    const badSkillPath = path.join(globalDir, 'bad-skill', 'SKILL.md');
    await writeFile(badSkillPath, '---\nname: [unclosed\n---\nBody', 'utf8');

    const provider = new TestSkillsProvider();
    provider.sources = [
      { rootDir: globalDir, recursive: true, scope: 'user', commandPrefix: '/' } as ProviderSkillSource,
    ];

    const skills = await provider.listSkills({ workspacePath: projectDir });
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'good-skill');
    assert.equal(skills[0].command, '/good-skill');
    assert.equal(skills[0].scope, 'user');
  });
});

test('listSkills: uses commandForSkill when provided instead of the prefix', async () => {
  await withTempDir(async (root) => {
    const dir = path.join(root, 'plugin-skills');
    await mkdir(path.join(dir, 'my-skill'), { recursive: true });
    await writeFile(
      path.join(dir, 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\ndescription: desc\n---\nBody',
      'utf8',
    );

    const provider = new TestSkillsProvider();
    provider.sources = [
      {
        rootDir: dir,
        recursive: true,
        scope: 'plugin',
        pluginName: 'demo',
        pluginId: 'demo@1',
        commandForSkill: (name: string) => `custom:${name}`,
      } as unknown as ProviderSkillSource,
    ];

    const skills = await provider.listSkills();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].command, 'custom:my-skill');
    assert.equal(skills[0].pluginName, 'demo');
  });
});

test('addSkills: rejects when the provider has no managed global skill source', async () => {
  const provider = new TestSkillsProvider();
  provider.globalSource = null;
  await assert.rejects(
    () => provider.addSkills({ entries: [{ content: '---\nname: x\n---\nBody' }] } as any),
    /does not support managed global skills/,
  );
});

test('addSkills: rejects an empty entries array', async () => {
  await withTempDir(async (root) => {
    const provider = new TestSkillsProvider();
    provider.globalSource = { rootDir: root, recursive: true, scope: 'user' } as ProviderSkillSource;
    await assert.rejects(() => provider.addSkills({ entries: [] } as any), /At least one skill entry is required/);
  });
});

test('addSkills: rejects a blank-content entry', async () => {
  await withTempDir(async (root) => {
    const provider = new TestSkillsProvider();
    provider.globalSource = { rootDir: root, recursive: true, scope: 'user' } as ProviderSkillSource;
    await assert.rejects(
      () => provider.addSkills({ entries: [{ content: '   ' }] } as any),
      /must include markdown content/,
    );
  });
});

test('addSkills: writes SKILL.md + supporting files, normalizing an odd directory name', async () => {
  await withTempDir(async (root) => {
    const provider = new TestSkillsProvider();
    provider.globalSource = { rootDir: root, recursive: true, scope: 'user', commandPrefix: '/' } as ProviderSkillSource;

    const [skill] = await provider.addSkills({
      entries: [
        {
          directoryName: 'My Weird/Skill:Name',
          content: '---\nname: weird-skill\ndescription: d\n---\nBody',
          files: [
            { relativePath: 'assets/logo.png', content: Buffer.from('abc').toString('base64'), encoding: 'base64' },
            { relativePath: 'notes.txt', content: 'hello' },
          ],
        },
      ],
    } as any);

    assert.equal(skill.name, 'weird-skill');
    const expectedDir = path.join(root, 'My-Weird-Skill-Name');
    const skillMd = await readFile(path.join(expectedDir, 'SKILL.md'), 'utf8');
    assert.match(skillMd, /name: weird-skill/);
    const notes = await readFile(path.join(expectedDir, 'notes.txt'), 'utf8');
    assert.equal(notes, 'hello');
    const logo = await readFile(path.join(expectedDir, 'assets', 'logo.png'));
    assert.equal(logo.toString(), 'abc');
  });
});

test('addSkills: rejects a supporting file path that escapes the skill directory', async () => {
  await withTempDir(async (root) => {
    const provider = new TestSkillsProvider();
    provider.globalSource = { rootDir: root, recursive: true, scope: 'user' } as ProviderSkillSource;

    await assert.rejects(
      () => provider.addSkills({
        entries: [{
          content: '---\nname: escape-skill\n---\nBody',
          files: [{ relativePath: '../../escape.txt', content: 'x' }],
        }],
      } as any),
      /invalid supporting file path|must stay inside the skill directory/,
    );

    await assert.rejects(
      () => provider.addSkills({
        entries: [{
          content: '---\nname: escape-skill2\n---\nBody',
          files: [{ relativePath: 'SKILL.md', content: 'x' }],
        }],
      } as any),
      /invalid supporting file path/,
    );
  });
});

test('addSkills: rejects duplicate skill targets within one request', async () => {
  await withTempDir(async (root) => {
    const provider = new TestSkillsProvider();
    provider.globalSource = { rootDir: root, recursive: true, scope: 'user' } as ProviderSkillSource;

    await assert.rejects(
      () => provider.addSkills({
        entries: [
          { directoryName: 'dup', content: '---\nname: dup\n---\nBody' },
          { directoryName: 'dup', content: '---\nname: dup\n---\nBody2' },
        ],
      } as any),
      /Duplicate skill target/,
    );
  });
});

test('addSkills: rejects duplicate supporting file paths within one entry', async () => {
  await withTempDir(async (root) => {
    const provider = new TestSkillsProvider();
    provider.globalSource = { rootDir: root, recursive: true, scope: 'user' } as ProviderSkillSource;

    await assert.rejects(
      () => provider.addSkills({
        entries: [{
          content: '---\nname: dupfile\n---\nBody',
          files: [
            { relativePath: 'a.txt', content: '1' },
            { relativePath: 'a.txt', content: '2' },
          ],
        }],
      } as any),
      /duplicate supporting file path/,
    );
  });
});

test('addSkills: an entry with no explicit name falls back to a fileName- or index-derived directory', async () => {
  await withTempDir(async (root) => {
    const provider = new TestSkillsProvider();
    provider.globalSource = { rootDir: root, recursive: true, scope: 'user' } as ProviderSkillSource;

    const skills = await provider.addSkills({
      entries: [{ fileName: 'from-file.md', content: 'Just a body, no frontmatter at all' }],
    } as any);

    assert.equal(skills.length, 1);
    // No frontmatter name -> readProviderSkillMarkdownDefinitionFromContent falls
    // back to the normalized directory-name-derived fallback.
    assert.ok(skills[0].name.length > 0);
  });
});

test('addSkills: replaces an existing skill directory wholesale (stale files do not survive)', async () => {
  await withTempDir(async (root) => {
    const provider = new TestSkillsProvider();
    provider.globalSource = { rootDir: root, recursive: true, scope: 'user' } as ProviderSkillSource;

    await provider.addSkills({
      entries: [{ directoryName: 'replace-me', content: '---\nname: replace-me\n---\nV1', files: [{ relativePath: 'stale.txt', content: 'old' }] }],
    } as any);
    assert.ok(await readFile(path.join(root, 'replace-me', 'stale.txt'), 'utf8'));

    await provider.addSkills({
      entries: [{ directoryName: 'replace-me', content: '---\nname: replace-me\n---\nV2' }],
    } as any);

    await assert.rejects(() => readFile(path.join(root, 'replace-me', 'stale.txt'), 'utf8'));
    const skillMd = await readFile(path.join(root, 'replace-me', 'SKILL.md'), 'utf8');
    assert.match(skillMd, /V2/);
  });
});

test('removeSkill: rejects when unsupported, when directoryName is missing, and when it escapes the root', async () => {
  const noGlobal = new TestSkillsProvider();
  await assert.rejects(() => noGlobal.removeSkill({ directoryName: 'x' }), /does not support managed global skills/);

  await withTempDir(async (root) => {
    const provider = new TestSkillsProvider();
    provider.globalSource = { rootDir: root, recursive: true, scope: 'user' } as ProviderSkillSource;

    await assert.rejects(() => provider.removeSkill({ directoryName: '   ' }), /directoryName is required/);
    // Note: the "must stay inside the managed skill root" branch right after
    // this normalizes `directoryName` first (normalizeSkillDirectoryName strips
    // slashes and leading/trailing dots), so a literal "../escape" collapses to
    // "escape" and a bare ".." collapses to "" (caught by the empty-name check
    // above) before ever reaching that guard — it isn't reachable through the
    // public addSkills/removeSkill API today; left uncovered as defense-in-depth
    // rather than exercised via a synthetic bypass of the public contract.
  });
});

test('removeSkill: removes an existing directory and reports removed:false for a missing one', async () => {
  await withTempDir(async (root) => {
    const provider = new TestSkillsProvider();
    provider.globalSource = { rootDir: root, recursive: true, scope: 'user' } as ProviderSkillSource;
    await mkdir(path.join(root, 'to-remove'), { recursive: true });
    await writeFile(path.join(root, 'to-remove', 'SKILL.md'), 'body', 'utf8');

    const result = await provider.removeSkill({ directoryName: 'to-remove' });
    assert.deepEqual(result, { removed: true, provider: 'claude', directoryName: 'to-remove' });
    await assert.rejects(() => readFile(path.join(root, 'to-remove', 'SKILL.md'), 'utf8'));

    const missing = await provider.removeSkill({ directoryName: 'never-existed' });
    assert.equal(missing.removed, false);
  });
});

test('getGlobalSkillSource default implementation returns null (base class contract)', async () => {
  class BareProvider extends SkillsProvider {
    constructor() { super('codex'); }
    protected async getSkillSources(): Promise<ProviderSkillSource[]> { return []; }
  }
  const provider = new BareProvider();
  await assert.rejects(() => provider.addSkills({ entries: [{ content: 'x' }] } as any), /does not support managed global skills/);
});
