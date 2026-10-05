import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AppError, type SkillPresetInfo, type SkillScan } from '@kepcup/shared';

import type { CoreLogger } from '../infra/logger.js';
import { resolvePresetSkillsDir } from '../infra/paths.js';
import { hashDirectory } from './library.js';
import { parseSkillDir } from './parse.js';
import { scanSkillDir } from './scan.js';
import type { SkillsService } from './registry.js';

/**
 * Preset skills ("技能市场", apps/desktop/resources/preset-skills/): the
 * app-shipped catalog behind the marketplace UI. Installation reuses the P08
 * import pipeline (parse → scan → content-hash → installPublic) and lands in
 * the PUBLIC scope — one install, every bot discovers and calls it
 * (`public_skills`). Presets are trusted app content, so there is no approval
 * card; the user's explicit 「添加」 click IS the install decision (unlike
 * git imports, which keep the per-bot private approval flow).
 *
 * Library entries installed from here carry `source_url = preset://{id}`, the
 * marker that lets a newer app version REPLACE an outdated public preset in
 * place (uninstall → reference-counted GC → install new content). Same-name
 * PUBLIC entries from any other source are never clobbered — ALREADY_EXISTS.
 * A bot's private same-name skill is not a conflict either: it shadows the
 * public version for that bot only.
 */

const catalogEntrySchema = z.object({
  id: z.string().min(1).max(64),
  /** Directory under the preset-skills root; must contain a SKILL.md. */
  dir: z.string().min(1).max(200),
  section: z.string().min(1).max(64),
  displayName: z.string().min(1).max(100),
  summary: z.string().min(1).max(500),
  icon: z.string().min(1).max(64).default('puzzle'),
  version: z.string().min(1).max(32),
  tryIt: z.string().max(500).default(''),
  /**
   * Verbatim import of an upstream official skill (e.g. mineru, AGPL-3.0).
   * Its SKILL.md must never be hand-edited — sync via
   * `scripts/sync-mineru-skill.mjs` and bump `version`. The catalog-guard
   * test relaxes the description cap for these entries (upstream trigger
   * text is kept intact) and asserts full compatibility.
   */
  vendored: z.boolean().optional(),
});

const catalogSchema = z.object({
  version: z.number(),
  presets: z.array(catalogEntrySchema),
});

type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/** source_url marker of library entries installed from the preset catalog. */
export const PRESET_SOURCE_PREFIX = 'preset://';

export interface SkillPresetsDeps {
  env: NodeJS.ProcessEnv;
  logger: CoreLogger;
  skills: SkillsService;
  /** Missing-dependency detection for the marketplace badge (optional, same as registry). */
  environment?: { depAvailable(dep: string): boolean } | undefined;
  /** P12 enhanced-sandbox availability at scan time (optional, same as registry). */
  enhancedSandbox?: { available(): boolean } | undefined;
}

/** One catalog entry resolved against its files (parse + scan + hash). */
interface ResolvedPreset {
  entry: CatalogEntry;
  /** Skill name from SKILL.md frontmatter (the registry-level identifier). */
  name: string;
  scan: SkillScan;
  contentHash: string;
  dir: string;
}

export class SkillPresetsService {
  readonly #deps: SkillPresetsDeps;
  readonly #presetsDir: string | null;

  constructor(deps: SkillPresetsDeps) {
    this.#deps = deps;
    this.#presetsDir = resolvePresetSkillsDir(deps.env);
    if (this.#presetsDir === null) {
      deps.logger.info('preset skills directory not found; skill marketplace will be empty');
    }
  }

  /**
   * Catalog with global install state (public scope). Re-reads and re-scans
   * every call — the whole catalog is a few hundred KB, and this keeps
   * shipped-content edits visible without cache invalidation logic.
   */
  list(): SkillPresetInfo[] {
    return this.#resolveAll().map((preset) => {
      const row = this.#deps.skills.publicSkillRow(preset.name);
      const state = this.#installState(row, preset);
      return {
        id: preset.entry.id,
        skillName: preset.name,
        displayName: preset.entry.displayName,
        summary: preset.entry.summary,
        icon: preset.entry.icon,
        section: preset.entry.section,
        version: preset.entry.version,
        tryIt: preset.entry.tryIt,
        missingDeps: preset.scan.runtimeDeps.filter((dep) => !this.#depAvailable(dep)),
        ...state,
      };
    });
  }

  /**
   * Installs one preset as a PUBLIC skill. Idempotent for identical content;
   * replaces an outdated `preset://` public entry in place; refuses to
   * clobber same-name public entries from other sources. Bots keep private
   * same-name skills — those shadow the public version (no blocking).
   */
  install(presetId: string): SkillPresetInfo[] {
    const preset = this.#resolveAll().find((candidate) => candidate.entry.id === presetId);
    if (preset === undefined) {
      throw new AppError('NOT_FOUND', `预置技能 ${presetId} 不存在`);
    }
    const row = this.#deps.skills.publicSkillRow(preset.name);
    const state = this.#installState(row, preset);
    if (state.foreign) {
      throw new AppError(
        'ALREADY_EXISTS',
        `已存在同名公共技能「${preset.name}」（非预置来源），请先卸载后再添加`,
      );
    }
    if (state.installed && !state.upToDate && row !== null) {
      // Outdated preset install: drop the old public row first (GC collects
      // the library version when nothing references it), then reinstall.
      this.#deps.skills.uninstallPublic(preset.name);
    }
    this.#deps.skills.installPublic({
      name: preset.name,
      scan: preset.scan,
      sourceUrl: `${PRESET_SOURCE_PREFIX}${preset.entry.id}`,
      commitOid: preset.entry.version,
      contentHash: preset.contentHash,
      stagingDir: preset.dir,
    });
    return this.list();
  }

  /** install-state triple against the public scope. */
  #installState(
    row: ReturnType<SkillsService['publicSkillRow']>,
    preset: ResolvedPreset,
  ): { installed: boolean; upToDate: boolean; foreign: boolean } {
    if (row === null) return { installed: false, upToDate: false, foreign: false };
    const library = this.#deps.skills.libraryGet(row.library_id);
    if (library === null) {
      // Dangling reference: reinstallable.
      return { installed: true, upToDate: false, foreign: false };
    }
    if (library.content_hash === preset.contentHash) {
      return { installed: true, upToDate: true, foreign: false };
    }
    return {
      installed: true,
      upToDate: false,
      foreign: !library.source_url.startsWith(PRESET_SOURCE_PREFIX),
    };
  }

  /**
   * 未安装预置的提示词段（docs/design/22-file-skill-routing.md，D63）：
   * 置于 `<skills>` 之后，列出 id / 技能名 / 摘要（截断）与安装指引——模型
   * 面对处理不了的文件时据此匹配并用 install_skill(preset_id) 请求安装。
   * 预置是策展小集合（当前 9 条），整段注入远低于技能列表的 token 预算。
   */
  promptSection(): string {
    const notInstalled = this.#resolveAll().filter((preset) => {
      const state = this.#installState(this.#deps.skills.publicSkillRow(preset.name), preset);
      return !state.installed;
    });
    if (notInstalled.length === 0) return '';
    const lines = notInstalled.map((preset) => {
      const summary = truncateForPrompt(preset.entry.summary, 120);
      return `- ${preset.name}（preset_id: ${preset.entry.id}，v${preset.entry.version}）：${summary}`;
    });
    return [
      '<recommended_skills>',
      '以下是应用内置推荐技能（尚未安装）。需要处理它们擅长的文件或任务时，用 install_skill 工具传对应的 preset_id 请求用户授权安装；安装完成后即可像普通技能一样使用。',
      ...lines,
      '</recommended_skills>',
    ].join('\n');
  }

  /** `skill_preset` 审批 payload（install_skill 工具的 preset 路径）。 */
  describePreset(presetId: string): {
    presetId: string;
    name: string;
    displayName: string;
    summary: string;
    version: string;
    missingDeps: string[];
    installed: boolean;
  } {
    const preset = this.#resolveAll().find((candidate) => candidate.entry.id === presetId);
    if (preset === undefined) {
      throw new AppError('NOT_FOUND', `预置技能 ${presetId} 不存在`);
    }
    const row = this.#deps.skills.publicSkillRow(preset.name);
    const state = this.#installState(row, preset);
    return {
      presetId: preset.entry.id,
      name: preset.name,
      displayName: preset.entry.displayName,
      summary: preset.entry.summary,
      version: preset.entry.version,
      missingDeps: preset.scan.runtimeDeps.filter((dep) => !this.#depAvailable(dep)),
      installed: state.installed && state.upToDate,
    };
  }

  /** 已安装预置技能的 SKILL.md 绝对路径（安装后回给模型渐进披露）。 */
  installedSkillPath(skillName: string): string | null {
    const row = this.#deps.skills.publicSkillRow(skillName);
    if (row === null) return null;
    const library = this.#deps.skills.libraryGet(row.library_id);
    if (library === null) return null;
    return `${this.#deps.skills.libraryDirOf(library)}${path.sep}SKILL.md`;
  }

  /** Parses + scans + hashes every catalog entry; broken entries are skipped with a warning. */
  #resolveAll(): ResolvedPreset[] {
    if (this.#presetsDir === null) return [];
    const catalog = this.#readCatalog();
    if (catalog === null) return [];
    const resolved: ResolvedPreset[] = [];
    for (const entry of catalog.presets) {
      // dir is joined, never used as an absolute path — guard against path escapes.
      if (path.isAbsolute(entry.dir) || entry.dir.includes('..')) {
        this.#deps.logger.warn({ preset: entry.id, dir: entry.dir }, 'preset dir rejected');
        continue;
      }
      const dir = path.join(this.#presetsDir, entry.dir);
      if (!existsSync(path.join(dir, 'SKILL.md'))) {
        this.#deps.logger.warn({ preset: entry.id, dir: entry.dir }, 'preset dir has no SKILL.md');
        continue;
      }
      const parsed = parseSkillDir(dir);
      if (parsed === null) {
        this.#deps.logger.warn(
          { preset: entry.id, dir: entry.dir },
          'preset SKILL.md failed to parse',
        );
        continue;
      }
      resolved.push({
        entry,
        name: parsed.name,
        scan: scanSkillDir(dir, parsed, {
          enhancedSandboxAvailable: this.#deps.enhancedSandbox?.available() ?? false,
        }),
        contentHash: hashDirectory(dir),
        dir,
      });
    }
    return resolved;
  }

  #readCatalog(): z.infer<typeof catalogSchema> | null {
    if (this.#presetsDir === null) return null;
    const file = path.join(this.#presetsDir, 'catalog.json');
    try {
      const parsed = catalogSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      if (!parsed.success) {
        this.#deps.logger.warn({ file }, 'preset catalog.json failed schema validation');
        return null;
      }
      return parsed.data;
    } catch (error) {
      this.#deps.logger.warn(
        { file, error: error instanceof Error ? error.message : String(error) },
        'preset catalog.json unreadable',
      );
      return null;
    }
  }

  #depAvailable(dep: string): boolean {
    return this.#deps.environment?.depAvailable(dep) ?? false;
  }
}

function truncateForPrompt(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
