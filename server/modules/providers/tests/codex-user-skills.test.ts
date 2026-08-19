import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { providerSkillsService } from '@/modules/providers/services/skills.service.js';

/**
 * `~/.codex/skills` is a skill source (#356).
 *
 * The reporter has around sixty skills in that directory, each a folder with a
 * `SKILL.md`, and none of them appeared. The provider enumerated
 * `~/.agents/skills` for user scope and `~/.codex/skills/.system` for system
 * scope — so it reached *inside* `~/.codex/skills` for the system subfolder
 * while never reading the directory that subfolder lives in.
 *
 * That the directory is Codex's own is not an inference: Codex writes
 * `~/.codex/skills/.system/.codex-system-skills.marker` there itself, which is
 * the very path the system source already relies on.
 */

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as unknown as { homedir: () => string }).homedir = original;
  };
};

const writeSkill = async (
  skillsRoot: string,
  directoryName: string,
  name: string,
  description: string,
): Promise<string> => {
  const skillDir = path.join(skillsRoot, directoryName);
  await fs.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(skillPath, `---\nname: ${name}\ndescription: ${description}\n---\n\n`, 'utf8');
  return skillPath;
};

test('codex lists skills kept directly in ~/.codex/skills (#356)', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-user-skills-'));
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const workspacePath = path.join(tempRoot, 'workspace');
    await fs.mkdir(workspacePath, { recursive: true });
    await writeSkill(path.join(tempRoot, '.codex', 'skills'), 'okr', 'okr', 'Quarterly OKRs');

    const skills = await providerSkillsService.listProviderSkills('codex', { workspacePath });
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    assert.equal(byName.get('okr')?.scope, 'user');
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('codex does not list its system marker folder as a user skill', { concurrency: false }, async () => {
  // `.system` is a real subdirectory of the new source, and it is already
  // enumerated separately at system scope. Reading the parent must not make its
  // contents show up a second time under the wrong scope, or every system skill
  // is duplicated the moment this source is added.
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-user-skills-'));
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const workspacePath = path.join(tempRoot, 'workspace');
    await fs.mkdir(workspacePath, { recursive: true });
    await writeSkill(
      path.join(tempRoot, '.codex', 'skills', '.system'),
      'imagegen',
      'imagegen',
      'System image generation',
    );

    const skills = await providerSkillsService.listProviderSkills('codex', { workspacePath });
    const matches = skills.filter((skill) => skill.name === 'imagegen');

    assert.equal(matches.length, 1, 'system skill must appear exactly once');
    assert.equal(matches[0]?.scope, 'system');
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('codex follows a symlinked skill folder in ~/.codex/skills', { concurrency: false }, async () => {
  // Not hypothetical: the reporter's own directory contains
  // `anmol -> ~/repos/life-ops/anmol`. #345 was this same defect for claude, so
  // the new source is pinned against regressing it here.
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-user-skills-'));
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const workspacePath = path.join(tempRoot, 'workspace');
    await fs.mkdir(workspacePath, { recursive: true });
    const external = path.join(tempRoot, 'external');
    await writeSkill(external, 'linked', 'linked-skill', 'Lives outside the skills root');

    const skillsRoot = path.join(tempRoot, '.codex', 'skills');
    await fs.mkdir(skillsRoot, { recursive: true });
    await fs.symlink(path.join(external, 'linked'), path.join(skillsRoot, 'linked'), 'dir');

    const skills = await providerSkillsService.listProviderSkills('codex', { workspacePath });

    assert.ok(
      skills.some((skill) => skill.name === 'linked-skill'),
      'a symlinked skill folder must be discovered',
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
