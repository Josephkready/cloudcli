import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findProviderSkillMarkdownFiles } from '@/shared/utils.js';

/**
 * Symlinked skill directories (#345).
 *
 * A skill folder is very often a symlink: the canonical copy lives in the repo
 * that owns it and `~/.claude/skills/<name>` points at it, which is how a skill
 * stays versioned with its project while remaining globally invokable. Node's
 * `Dirent.isDirectory()` describes the *link*, not its target, so it answers
 * false for every one of those and the scanner walked straight past them.
 */
async function withSkillTree(
  run: (paths: { root: string; external: string }) => Promise<void>,
): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-symlinks-'));
  const root = path.join(dir, 'skills');
  const external = path.join(dir, 'external');
  try {
    await fsp.mkdir(root, { recursive: true });
    await fsp.mkdir(external, { recursive: true });
    await run({ root, external });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function writeSkill(skillDir: string, name: string): Promise<void> {
  await fsp.mkdir(skillDir, { recursive: true });
  await fsp.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\nBody.\n`,
  );
}

test('a symlinked skill directory is discovered alongside real ones', async () => {
  await withSkillTree(async ({ root, external }) => {
    await writeSkill(path.join(root, 'real-skill'), 'real-skill');
    await writeSkill(path.join(external, 'mind'), 'mind');
    await fsp.symlink(path.join(external, 'mind'), path.join(root, 'mind'));

    const found = await findProviderSkillMarkdownFiles(root);

    assert.deepEqual(
      found.map((filePath) => path.basename(path.dirname(filePath))).sort(),
      ['mind', 'real-skill'],
      'the symlinked skill must be discovered, not skipped',
    );
  });
});

test('a symlinked skill directory is discovered in recursive mode', async () => {
  await withSkillTree(async ({ root, external }) => {
    await writeSkill(path.join(external, 'mind-search'), 'mind-search');
    await fsp.symlink(path.join(external, 'mind-search'), path.join(root, 'mind-search'));

    const found = await findProviderSkillMarkdownFiles(root, { recursive: true });

    assert.deepEqual(found, [path.join(root, 'mind-search', 'SKILL.md')]);
  });
});

test('a symlink pointing at a file, not a directory, is not treated as a skill folder', async () => {
  await withSkillTree(async ({ root, external }) => {
    await fsp.mkdir(root, { recursive: true });
    await fsp.mkdir(external, { recursive: true });
    const notADirectory = path.join(external, 'notes.md');
    await fsp.writeFile(notADirectory, '# not a skill');
    await fsp.symlink(notADirectory, path.join(root, 'notes.md'));

    assert.deepEqual(await findProviderSkillMarkdownFiles(root), []);
  });
});

test('a broken symlink is skipped rather than failing the whole scan', async () => {
  await withSkillTree(async ({ root, external }) => {
    await writeSkill(path.join(root, 'healthy'), 'healthy');
    await fsp.symlink(path.join(external, 'never-existed'), path.join(root, 'dangling'));

    const found = await findProviderSkillMarkdownFiles(root);

    assert.deepEqual(found, [path.join(root, 'healthy', 'SKILL.md')]);
  });
});

test('a symlink loop terminates instead of recursing forever', async () => {
  await withSkillTree(async ({ root }) => {
    await writeSkill(path.join(root, 'looping'), 'looping');
    // A child that points back at its own ancestor — the classic infinite walk.
    await fsp.symlink(root, path.join(root, 'looping', 'self'));

    const found = await findProviderSkillMarkdownFiles(root, { recursive: true });

    assert.ok(
      found.includes(path.join(root, 'looping', 'SKILL.md')),
      'the real skill is still found',
    );
  });
});
