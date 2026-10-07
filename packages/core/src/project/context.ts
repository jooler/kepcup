import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { Repository } from 'es-git';
import { PROJECT_CONTEXT_MAX_ENTRIES, PROJECT_CONTEXT_TOKEN_BUDGET } from '@kepcup/shared';

import { truncateToBudget } from '../agent/tokens.js';

/**
 * `<project>` context section (docs/design/08-project.md "上下文注入"):
 * path, a two-level top-of-tree listing that respects `.gitignore` (verdicts
 * come from the shadow repo's libgit2), the project's own git status (read
 * through es-git, never written) and the root `AGENTS.md` (preferred) /
 * `CLAUDE.md`.
 */

export interface ProjectContextInput {
  path: string;
  budget: number;
  /** libgit2 ignore verdict (shadow repo); null = no ignore filtering. */
  isIgnored: ((relativePath: string) => boolean) | null;
  /**
   * 项目约定文件中由外部智能体自己读取的（D72 `provider.agentSideConfigFiles`，
   * 如 Codex 的 `AGENTS.md`）：不再重复注入；其余候选照常注入。
   */
  skipGuideFiles?: readonly string[];
}

export interface ProjectContextSection {
  title: string;
  body: string;
}

/** Two-level, `.gitignore`-aware listing (capped). */
export function topTwoLevels(
  projectPath: string,
  isIgnored: ProjectContextInput['isIgnored'],
  maxEntries = PROJECT_CONTEXT_MAX_ENTRIES,
): string[] {
  const ignored = (relative: string): boolean => {
    if (isIgnored === null) return false;
    try {
      return isIgnored(relative);
    } catch {
      return false;
    }
  };
  const entries: string[] = [];
  let rootNames: string[];
  try {
    rootNames = readdirSync(projectPath).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
  for (const name of rootNames) {
    if (entries.length >= maxEntries) break;
    if (name === '.git') continue;
    const full = path.join(projectPath, name);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (ignored(isDir ? `${name}/` : name)) continue;
    entries.push(isDir ? `${name}/` : name);
    if (!isDir) continue;
    let children: string[];
    try {
      children = readdirSync(full).sort((a, b) => a.localeCompare(b));
    } catch {
      continue;
    }
    let added = 0;
    for (const child of children) {
      if (entries.length >= maxEntries || added >= 20) break;
      let childIsDir: boolean;
      try {
        childIsDir = statSync(path.join(full, child)).isDirectory();
      } catch {
        continue;
      }
      if (ignored(`${name}/${child}${childIsDir ? '/' : ''}`)) continue;
      entries.push(`  ${child}${childIsDir ? '/' : ''}`);
      added += 1;
    }
  }
  return entries;
}

export interface ProjectGitStatus {
  branch: string | null;
  dirtyCount: number;
  headSummary: string | null;
}

/** Reads the project's own git repo (read-only); null when not a repo. */
export async function projectGitStatus(projectPath: string): Promise<ProjectGitStatus | null> {
  const dotGit = path.join(projectPath, '.git');
  if (!existsSync(dotGit)) return null;
  const { openRepository } = await import('es-git');
  let repo: Repository;
  try {
    repo = await openRepository(dotGit);
  } catch {
    return null;
  }
  try {
    let branch: string | null = null;
    let headSummary: string | null = null;
    try {
      const head = repo.head();
      branch = head.name()?.replace('refs/heads/', '') ?? null;
      const target = head.target();
      if (target !== null) headSummary = repo.getCommit(target).summary();
    } catch {
      // Unborn HEAD.
    }
    const dirtyCount = drainStatuses(repo).length;
    return { branch, dirtyCount, headSummary };
  } catch {
    return null;
  }
}

function drainStatuses(repo: Repository): string[] {
  const paths: string[] = [];
  const statuses = repo.statuses();
  for (let i = 0; i < Number(statuses.len()); i++) {
    const entry = statuses.get(i);
    if (entry !== null) paths.push(entry.path());
  }
  return paths;
}

/** Builds the `<project>` prompt section, or null when there is no project. */
export async function buildProjectSection(input: ProjectContextInput): Promise<ProjectContextSection | null> {
  const { path: projectPath, budget } = input;
  const lines: string[] = [`项目目录：${projectPath}`, '文件工具与命令的默认工作目录是项目目录。'];

  const entries = topTwoLevels(projectPath, input.isIgnored);
  lines.push(
    entries.length > 0
      ? `顶层结构（两层，遵守 .gitignore）：\n${entries.join('\n')}`
      : '顶层结构：（空）',
  );

  const git = await projectGitStatus(projectPath);
  if (git !== null) {
    lines.push(
      `git 状态：${git.branch !== null ? `分支 ${git.branch}` : '（游离 HEAD）'}${
        git.dirtyCount > 0 ? `，${git.dirtyCount} 个文件有未提交改动` : '，工作区干净'
      }${git.headSummary !== null ? `，最新提交：${git.headSummary}` : ''}`,
    );
  }

  // Agents that read some guide themselves skip it (D72); the next candidate
  // is still injected — intended: e.g. Codex reads AGENTS.md but not
  // CLAUDE.md, so a project with both still shows Codex its CLAUDE.md here.
  const guideName = ['AGENTS.md', 'CLAUDE.md']
    .filter((name) => !(input.skipGuideFiles ?? []).includes(name))
    .find((name) => existsSync(path.join(projectPath, name)));
  if (guideName !== undefined) {
    try {
      const raw = readFileSync(path.join(projectPath, guideName), 'utf8');
      lines.push(`${guideName} 内容（项目约定，必须遵守）：\n${raw}`);
    } catch {
      // unreadable guide — skip
    }
  }

  const truncated = truncateToBudget(lines.join('\n'), budget);
  return {
    title: 'project',
    body: truncated.truncated ? `${truncated.text}\n（已截断）` : truncated.text,
  };
}

/** Budget used for the section (kept next to its builder). */
export const PROJECT_SECTION_BUDGET = PROJECT_CONTEXT_TOKEN_BUDGET;
