import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Local git fixture for the P08 import tests (docs/dev/05-testing.md: tests
 * never touch the real network). Creates a real git repository on disk via
 * the system git CLI; the import pipeline clones it with es-git over the
 * local path / file:// URL.
 */
export interface SkillRepoFixture {
  repoDir: string;
  /** file:// URL of the repo (alternative to the plain path). */
  fileUrl: string;
  commitOid(): string;
  /** Adds + commits more files (for multi-version scenarios). */
  commitFiles(files: Record<string, string>, message?: string): void;
  cleanup(): Promise<void>;
}

export function writeSkillFiles(root: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const target = path.join(root, relPath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function git(repoDir: string, args: string[]): void {
  const result = spawnSync(
    'git',
    ['-C', repoDir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', ...args],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? result.stdout}`);
  }
}

export async function createSkillRepo(
  files: Record<string, string>,
  options: { message?: string } = {},
): Promise<SkillRepoFixture> {
  const repoDir = await mkdtemp(path.join(tmpdir(), 'skill-repo-'));
  try {
    writeSkillFiles(repoDir, files);
    git(repoDir, ['init', '-q']);
    git(repoDir, ['add', '-A']);
    git(repoDir, ['commit', '-q', '-m', options.message ?? 'init']);
    const head = () => {
      const result = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      return result.stdout.trim();
    };
    return {
      repoDir,
      fileUrl: `file://${repoDir}`,
      commitOid: head,
      commitFiles(next: Record<string, string>, message?: string) {
        writeSkillFiles(repoDir, next);
        git(repoDir, ['add', '-A']);
        git(repoDir, ['commit', '-q', '-m', message ?? 'update']);
      },
      async cleanup() {
        await rm(repoDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(repoDir, { recursive: true, force: true });
    throw error;
  }
}

/** A minimal valid skill payload for fixtures. */
export function skillFiles(
  name: string,
  description: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    [`${name}/SKILL.md`]: [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      '---',
      '',
      `# ${name}`,
      '',
      '使用说明：运行 scripts/greet.sh。',
    ].join('\n'),
    [`${name}/scripts/greet.sh`]: '#!/usr/bin/env bash\necho "hello-from-skill"\n',
    ...extra,
  };
}
