import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { pluginManifestSchema, SKILL_DESCRIPTION_MAX_CHARS } from '@kepcup/shared';

import { parseSkillDir } from '../../src/skills/parse.js';
import { scanSkillDir } from '../../src/skills/scan.js';

/**
 * 守护随应用分发的内置插件 com.kepcup/starter-skills
 * （apps/desktop/resources/plugins/com.kepcup/starter-skills/，D104 P0b 起
 * 预置技能目录即此插件）：plugin.json 符合清单 schema、每个技能贡献都能被
 * parse/scan、兼容判定不为 incompatible。清单与技能内容一旦漂移，市场就会
 * 丢条目或展示坏数据。
 *
 * vendored 条目（如 mineru）是逐字引入的上游官方技能：description 沿用上游
 * 调优文本不删节（上限放宽到 SKILL_DESCRIPTION_MAX_CHARS，parse 层本就按它
 * 截断），但兼容性要求更严——必须完全 compatible，且 NOTICE.md 记录上游来源、
 * commit 锚点与许可（vendored 的再分发依据）。
 *
 * 目录定位 = 随包资源（仓库检出路径直接解析）；在打包环境等找不到目录的场合
 * 跳过（内容守护只在仓库检出时运行）。
 */

/** 随包原创技能的 description 上限：进 <skills> 提示词段（预算 500 token），必须克制。 */
const ORIGINAL_DESCRIPTION_MAX_CHARS = 300;

const pluginDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
  'apps/desktop/resources/plugins/com.kepcup/starter-skills',
);

describe('内置插件 com.kepcup/starter-skills（技能市场数据源）', () => {
  it.skipIf(!existsSync(pluginDir))('plugin.json 合法且技能贡献与目录一一对应', () => {
    const manifest = pluginManifestSchema.parse(
      JSON.parse(readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8')),
    );
    expect(manifest.id).toBe('com.kepcup/starter-skills');
    expect(manifest.contributions.skills.length).toBeGreaterThanOrEqual(8);

    const ids: string[] = [];
    for (const entry of manifest.contributions.skills) {
      // `dir` 形如 `skills/<id>`（preset id = 目录名，与 SKILL.md 的 name 一致）。
      expect(entry.dir).toMatch(/^skills\/[^/]+$/);
      const id = entry.dir.split('/')[1]!;
      expect(ids).not.toContain(id);
      ids.push(id);
      expect(existsSync(path.join(pluginDir, ...entry.dir.split('/'), 'SKILL.md'))).toBe(true);
    }
  });

  it.skipIf(!existsSync(pluginDir))('每个技能可被 parse/scan，且不声明宿主专有能力', () => {
    const manifest = pluginManifestSchema.parse(
      JSON.parse(readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8')),
    );
    for (const entry of manifest.contributions.skills) {
      const dir = path.join(pluginDir, ...entry.dir.split('/'));
      const parsed = parseSkillDir(dir);
      expect(parsed, `${entry.dir}: SKILL.md 应可解析`).not.toBeNull();
      const scan = scanSkillDir(dir, parsed);
      expect(scan.name).toBe(entry.dir.split('/')[1]);
      // 原创技能 ≤300；vendored 沿用上游触发文本不删节，放宽到 parse 层的截断上限
      const descriptionLimit =
        entry.vendored === true ? SKILL_DESCRIPTION_MAX_CHARS : ORIGINAL_DESCRIPTION_MAX_CHARS;
      expect(scan.description.length).toBeLessThanOrEqual(descriptionLimit);
      expect(scan.compatibility).not.toBe('incompatible');
      // 随包技能不声明增强沙箱/沙箱外执行
      expect(scan.sandboxDeclaration).toBeNull();
      expect(scan.declaredPermissions.network).toBe(false);
      expect(scan.declaredPermissions.credentials).toBe(false);
    }
  });

  it.skipIf(!existsSync(pluginDir))('NOTICE 声明原创性（不含上游专有内容）', () => {
    const notice = readFileSync(path.join(pluginDir, 'NOTICE.md'), 'utf8');
    expect(notice).toContain('原创');
  });

  it.skipIf(!existsSync(pluginDir))(
    'vendored 条目必须完全兼容，且 NOTICE 记录上游来源与许可',
    () => {
      const manifest = pluginManifestSchema.parse(
        JSON.parse(readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8')),
      );
      const vendored = manifest.contributions.skills.filter((entry) => entry.vendored === true);
      expect(vendored.length).toBeGreaterThanOrEqual(1);

      const notice = readFileSync(path.join(pluginDir, 'NOTICE.md'), 'utf8');
      for (const entry of vendored) {
        const dir = path.join(pluginDir, ...entry.dir.split('/'));
        const parsed = parseSkillDir(dir);
        expect(parsed, `${entry.dir}: SKILL.md 应可解析`).not.toBeNull();
        const scan = scanSkillDir(dir, parsed);
        // vendored 原文不做宿主适配——partial 意味着上游文本出现了本宿主不提供
        // 的能力词，此时应修上游适配而非放宽此断言
        expect(scan.compatibility, `${entry.dir}: ${scan.compatibilityReasons.join('; ')}`).toBe(
          'compatible',
        );
      }
      // 再分发依据三要素：来源、锚点 commit（40 位十六进制）、许可
      expect(notice).toContain('vendored');
      expect(notice).toContain('github.com/opendatalab/MinerU');
      expect(notice).toMatch(/[0-9a-f]{40}/);
      expect(notice).toContain('AGPL-3.0');
    },
  );
});
