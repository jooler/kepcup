import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  AppError,
  parsePluginSkillSource,
  pluginSkillSource,
  type PluginConflict,
  type PluginConsentSkill,
  type SkillScan,
} from '@kepcup/shared';
import type { CoreLogger } from '../../infra/logger.js';
import { hashDirectory } from '../../skills/library.js';
import { parseSkillDir } from '../../skills/parse.js';
import { isBuiltinSkillSource } from '../../skills/presets.js';
import { scanSkillDir } from '../../skills/scan.js';
import { resolveEffectiveCompatibility, type SkillsService } from '../../skills/registry.js';
import type {
  PluginIdentity,
  PluginLedger,
  PluginProjectionContext,
  PluginProjector,
  ProjectorInspection,
} from './index.js';

/**
 * Skills projector (D104 P0a-2 步骤 3): packaged skill folders land in the PUBLIC
 * scope through the same pipeline as the preset marketplace
 * (parse → scan → hash → `SkillsService.installPublic`), marked
 * `skill_library.source_url = plugin://{pluginId}/{skillName}`. Ownership lives in
 * the ledger; `source_url` is only consulted to avoid deleting someone else's
 * same-name skill (the library dedupes by `name@hash`, so it is not authoritative).
 * A same-name public skill installed from a builtin plugin (preset marketplace; never
 * in any ledger) is taken over on install / update instead of reported as a conflict.
 */

export interface SkillsProjectorDeps {
  skills: SkillsService;
  /** Missing-dependency detection for the consent card (optional, same as the registry). */
  environment?: { depAvailable(dep: string): boolean } | undefined;
  /** Enhanced-sandbox availability at scan time (optional, same as the registry). */
  enhancedSandbox?: { available(): boolean } | undefined;
  logger: Pick<CoreLogger, 'info' | 'warn' | 'error'>;
}

/** One resolved packaged skill: everything `project` needs, recomputed from `dir`. */
interface ResolvedSkill {
  name: string;
  scan: SkillScan;
  contentHash: string;
  dir: string;
}

export class SkillsProjector implements PluginProjector<PluginConsentSkill> {
  readonly kind = 'skill' as const;
  readonly #deps: SkillsProjectorDeps;

  constructor(deps: SkillsProjectorDeps) {
    this.#deps = deps;
  }

  async inspect(ctx: PluginProjectionContext): Promise<ProjectorInspection<PluginConsentSkill>> {
    const items: PluginConsentSkill[] = [];
    const conflicts: PluginConflict[] = [];
    const blockers: string[] = [];
    const seen = new Set<string>();
    for (const contribution of ctx.manifest.contributions.skills) {
      const dir = path.join(ctx.dir, ...contribution.dir.split('/'));
      const parsed = parseSkillDir(dir);
      if (parsed === null) {
        blockers.push(`技能 ${contribution.dir} 的 SKILL.md 无法解析`);
        continue;
      }
      const scan = scanSkillDir(dir, parsed, {
        enhancedSandboxAvailable: this.#deps.enhancedSandbox?.available() ?? false,
      });
      const effective = resolveEffectiveCompatibility(
        scan,
        this.#deps.enhancedSandbox?.available() ?? false,
      );
      // Incompatible does NOT block the install: `installPublic` registers it with an
      // `incompatible` status; the consent panel just flags it.
      items.push({
        name: parsed.name,
        description: parsed.description,
        runtimeDeps: scan.runtimeDeps,
        compatible: !effective.incompatible,
        incompatibleReason: effective.incompatible
          ? [scan.compatibilityReasons.join('；'), effective.installHint ?? '']
              .filter((part) => part.length > 0)
              .join(' ')
          : null,
      });
      if (seen.has(parsed.name.toLowerCase())) {
        blockers.push(`包内有两个技能解析出同名「${parsed.name}」`);
        continue;
      }
      seen.add(parsed.name.toLowerCase());
      // An update collides only with SOMEONE ELSE's public skill — the plugin's own
      // previous skills are excluded via the ledger-owned set (D104 P1-2), and a
      // builtin-installed preset is taken over by `project` rather than fought over.
      if (
        this.#deps.skills.publicSkillRow(parsed.name) !== null &&
        !ctx.owned.skill.has(parsed.name) &&
        !this.#builtinInstalled(parsed.name)
      ) {
        // Any other source counts: a Bot's private same-name skill only shadows, that is not a conflict.
        conflicts.push({ kind: 'skill', ref: parsed.name, withWhat: '已有同名公共技能' });
      }
    }
    return { items, conflicts, blockers };
  }

  async project(ctx: PluginProjectionContext): Promise<void> {
    for (const contribution of ctx.manifest.contributions.skills) {
      const resolved = this.#resolve(ctx, contribution.dir);
      if (resolved === null) {
        // Inspect rejects this earlier; a throw here is a programming error and the
        // registry rolls the already-written items back through the ledger.
        throw new AppError('PLUGIN_INVALID', `技能 ${contribution.dir} 的 SKILL.md 无法解析`);
      }
      ctx.ledger.add('skill', resolved.name);
      this.#adopt(ctx, resolved.name);
      this.#installOne(ctx.plugin, resolved);
    }
  }

  /**
   * Update (D104 P1-2): skills are replaced in place along the content hash
   * (`uninstallPublic` + `installPublic`, the preset update mechanism); skills the new
   * manifest dropped are removed with the same ownership check as `unproject`. A reverse
   * `update` (new → old) restores the previous version exactly — the old content still
   * lives in the library under its own hash — so there is no `beginUpdate` snapshot.
   */
  async update(oldCtx: PluginProjectionContext, newCtx: PluginProjectionContext): Promise<void> {
    // Skill identity is the parsed SKILL.md name, not the contribution dir: a version that
    // only moved a skill's folder must keep the skill, and a kept dir whose NAME changed
    // must remove the old one. Resolve both sides before touching anything.
    const newNames = new Set<string>();
    for (const contribution of newCtx.manifest.contributions.skills) {
      const resolved = this.#resolve(newCtx, contribution.dir);
      if (resolved !== null) newNames.add(resolved.name);
    }
    for (const contribution of newCtx.manifest.contributions.skills) {
      const resolved = this.#resolve(newCtx, contribution.dir);
      if (resolved === null) {
        throw new AppError('PLUGIN_INVALID', `技能 ${contribution.dir} 的 SKILL.md 无法解析`);
      }
      newCtx.ledger.add('skill', resolved.name);
      const row = this.#deps.skills.publicSkillRow(resolved.name);
      if (row !== null) {
        const library = this.#deps.skills.libraryGet(row.library_id);
        const source = library?.source_url ?? '';
        const ours =
          library === null || parsePluginSkillSource(source)?.pluginId === newCtx.plugin.id;
        if (!ours && !isBuiltinSkillSource(source)) {
          // Someone else's skill — the shared name is not ours to replace.
          throw new AppError(
            'PLUGIN_CONFLICT',
            `公共技能 ${resolved.name} 由其它来源提供，不能由本插件更新`,
          );
        }
        // A builtin-installed preset is taken over as in `project`: dropped and re-owned
        // even when the content is identical, so the name ends up marked as ours.
        if (ours && library?.content_hash === resolved.contentHash) continue;
        this.#deps.skills.uninstallPublic(resolved.name);
      }
      this.#installOne(newCtx.plugin, resolved);
    }
    // Skills the new version dropped (no longer among the resolved names): the same guarded
    // removal as `unproject`.
    for (const contribution of oldCtx.manifest.contributions.skills) {
      const resolved = this.#resolve(oldCtx, contribution.dir);
      if (resolved === null) continue; // content unreadable: nothing projected to remove
      if (newNames.has(resolved.name)) continue;
      this.#removeOne(oldCtx.plugin, resolved.name);
      oldCtx.ledger.remove('skill', resolved.name);
    }
  }

  async unproject(
    plugin: PluginIdentity,
    refs: readonly string[],
    ledger: PluginLedger,
  ): Promise<void> {
    for (const name of refs) {
      this.#removeOne(plugin, name);
      ledger.remove('skill', name);
    }
  }

  async setEnabled(
    ctx: PluginProjectionContext,
    refs: readonly string[],
    enabled: boolean,
  ): Promise<void> {
    if (!enabled) {
      // Same removal as unproject, but the projected items stay in the ledger.
      for (const name of refs) this.#removeOne(ctx.plugin, name);
      return;
    }
    // Reinstall only the names whose public row is gone; the ledger entries never left.
    // Skills are identified by their SKILL.md name, which the manifest does not carry;
    // resolve by re-parsing every packaged folder and matching the parsed name.
    for (const name of refs) {
      if (this.#deps.skills.publicSkillRow(name) !== null) continue;
      const resolved = this.#resolveByName(ctx, name);
      if (resolved === null) {
        // Content deleted outside the app: `plugins.list` shows it as missing; nothing to do here.
        this.#deps.logger.warn(
          { plugin: ctx.plugin.id, skill: name },
          'plugin skill reinstall skipped: content missing',
        );
        continue;
      }
      this.#installOne(ctx.plugin, resolved);
    }
  }

  missing(plugin: PluginIdentity, refs: readonly string[]): string[] {
    void plugin;
    return refs.filter((name) => {
      const row = this.#deps.skills.publicSkillRow(name);
      if (row === null) return true;
      const library = this.#deps.skills.libraryGet(row.library_id);
      if (library === null) return true;
      return !existsSync(this.#deps.skills.libraryDirOf(library));
    });
  }

  // --- internals ---------------------------------------------------------------

  #resolve(ctx: PluginProjectionContext, relativeDir: string): ResolvedSkill | null {
    const dir = path.join(ctx.dir, ...relativeDir.split('/'));
    const parsed = parseSkillDir(dir);
    if (parsed === null) return null;
    return {
      name: parsed.name,
      scan: scanSkillDir(dir, parsed, {
        enhancedSandboxAvailable: this.#deps.enhancedSandbox?.available() ?? false,
      }),
      contentHash: hashDirectory(dir),
      dir,
    };
  }

  #resolveByName(ctx: PluginProjectionContext, name: string): ResolvedSkill | null {
    for (const contribution of ctx.manifest.contributions.skills) {
      const resolved = this.#resolve(ctx, contribution.dir);
      if (resolved !== null && resolved.name === name) return resolved;
    }
    return null;
  }

  /**
   * Is the public skill under `name` a builtin-installed preset (the preset marketplace,
   * or a `preset://` row migration 0054 rewrote)? Builtins never enter a plugin ledger,
   * so an installable plugin shipping the same name takes it over instead of conflicting.
   */
  #builtinInstalled(name: string): boolean {
    const row = this.#deps.skills.publicSkillRow(name);
    if (row === null) return false;
    const library = this.#deps.skills.libraryGet(row.library_id);
    return library !== null && isBuiltinSkillSource(library.source_url);
  }

  /**
   * Drops a builtin-installed same-name public row ahead of `#installOne`, so the install
   * re-owns the name: `installPublic` would reject a different version as ALREADY_EXISTS,
   * and the ledger's later `#removeOne` only deletes rows marked with this plugin's id.
   */
  #adopt(ctx: PluginProjectionContext, name: string): void {
    if (ctx.owned.skill.has(name) || !this.#builtinInstalled(name)) return;
    this.#deps.logger.info(
      { plugin: ctx.plugin.id, skill: name },
      'plugin skill install: taking over a builtin-installed public skill',
    );
    this.#deps.skills.uninstallPublic(name);
  }

  #installOne(plugin: PluginIdentity, resolved: ResolvedSkill): void {
    this.#deps.skills.installPublic({
      name: resolved.name,
      scan: resolved.scan,
      sourceUrl: pluginSkillSource(plugin.id, resolved.name),
      commitOid: plugin.version,
      contentHash: resolved.contentHash,
      stagingDir: resolved.dir,
    });
  }

  /** Never deletes another source's skill: ownership is verified via `source_url`. */
  #removeOne(plugin: PluginIdentity, name: string): void {
    const row = this.#deps.skills.publicSkillRow(name);
    if (row === null) return;
    const library = this.#deps.skills.libraryGet(row.library_id);
    const source = library?.source_url ?? '';
    if (parsePluginSkillSource(source)?.pluginId !== plugin.id) {
      this.#deps.logger.warn(
        { plugin: plugin.id, skill: name, sourceUrl: source },
        'plugin skill uninstall skipped: owned by another source',
      );
      return;
    }
    this.#deps.skills.uninstallPublic(name);
  }
}
