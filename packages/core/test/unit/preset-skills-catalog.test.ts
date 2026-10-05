import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SKILL_DESCRIPTION_MAX_CHARS } from '@kepcup/shared';

import { resolvePresetSkillsDir } from '../../src/infra/paths.js';
import { parseSkillDir } from '../../src/skills/parse.js';
import { scanSkillDir } from '../../src/skills/scan.js';

/**
 * 守护随应用分发的预置技能目录（apps/desktop/resources/preset-skills/）：
 * catalog.json 符合 schema、每个条目都能被 parse/scan、兼容判定不为
 * incompatible。内容与 catalog 一旦漂移，市场就会丢条目或展示坏数据。
 *
 * vendored 条目（如 mineru）是逐字引入的上游官方技能：description 沿用上游
 * 调优文本不删节（上限放宽到 SKILL_DESCRIPTION_MAX_CHARS，parse 层本就按它
 * 截断），但兼容性要求更严——必须完全 compatible，且 NOTICE.md 记录上游来源、
 * commit 锚点与许可（vendored 的再分发依据）。
 *
 * 目录定位与运行时一致（resolvePresetSkillsDir 的 walk-up）；在打包环境等
 * 找不到目录的场合跳过（内容守护只在仓库检出时运行）。
 */

const catalogEntrySchema = z.object({
  id: z.string().min(1),
  dir: z.string().min(1),
  section: z.string().min(1),
  displayName: z.string().min(1),
  summary: z.string().min(1),
  icon: z.string().min(1),
  version: z.string().min(1),
  tryIt: z.string(),
  vendored: z.boolean().optional(),
});

/** 随包原创技能的 description 上限：进 <skills> 提示词段（预算 500 token），必须克制。 */
const ORIGINAL_DESCRIPTION_MAX_CHARS = 300;

const presetsDir = resolvePresetSkillsDir({}) ?? path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
  'apps/desktop/resources/preset-skills',
);

describe('随包预置技能目录（技能市场数据源）', () => {
  it.skipIf(!existsSync(presetsDir))('catalog.json 合法且条目与目录一一对应', () => {
    const catalog = JSON.parse(readFileSync(path.join(presetsDir, 'catalog.json'), 'utf8')) as {
      version: number;
      presets: unknown[];
    };
    expect(catalog.version).toBeGreaterThanOrEqual(1);
    expect(catalog.presets.length).toBeGreaterThanOrEqual(8);

    const ids: string[] = [];
    for (const raw of catalog.presets) {
      const entry = catalogEntrySchema.parse(raw);
      expect(ids).not.toContain(entry.id);
      ids.push(entry.id);
      expect(entry.dir).not.toMatch(/[/\\]|^\.|^\.\./);
      expect(existsSync(path.join(presetsDir, entry.dir, 'SKILL.md'))).toBe(true);
    }
  });

  it.skipIf(!existsSync(presetsDir))('每个技能可被 parse/scan，且不声明宿主专有能力', () => {
    const catalog = JSON.parse(readFileSync(path.join(presetsDir, 'catalog.json'), 'utf8')) as {
      presets: Array<{ id: string; dir: string; vendored?: boolean }>;
    };
    for (const entry of catalog.presets) {
      const dir = path.join(presetsDir, entry.dir);
      const parsed = parseSkillDir(dir);
      expect(parsed, `${entry.dir}: SKILL.md 应可解析`).not.toBeNull();
      const scan = scanSkillDir(dir, parsed);
      expect(scan.name).toBe(entry.id);
      // 原创技能 ≤300；vendored 沿用上游触发文本不删节，放宽到 parse 层的截断上限
      const descriptionLimit = entry.vendored === true
        ? SKILL_DESCRIPTION_MAX_CHARS
        : ORIGINAL_DESCRIPTION_MAX_CHARS;
      expect(scan.description.length).toBeLessThanOrEqual(descriptionLimit);
      expect(scan.compatibility).not.toBe('incompatible');
      // 随包技能不声明增强沙箱/沙箱外执行
      expect(scan.sandboxDeclaration).toBeNull();
      expect(scan.declaredPermissions.network).toBe(false);
      expect(scan.declaredPermissions.credentials).toBe(false);
    }
  });

  it.skipIf(!existsSync(presetsDir))('NOTICE 声明原创性（不含上游专有内容）', () => {
    const notice = readFileSync(path.join(presetsDir, 'NOTICE.md'), 'utf8');
    expect(notice).toContain('原创');
  });

  it.skipIf(!existsSync(presetsDir))('vendored 条目必须完全兼容，且 NOTICE 记录上游来源与许可', () => {
    const catalog = JSON.parse(readFileSync(path.join(presetsDir, 'catalog.json'), 'utf8')) as {
      presets: Array<{ id: string; dir: string; vendored?: boolean }>;
    };
    const vendored = catalog.presets.filter((entry) => entry.vendored === true);
    expect(vendored.length).toBeGreaterThanOrEqual(1);

    const notice = readFileSync(path.join(presetsDir, 'NOTICE.md'), 'utf8');
    for (const entry of vendored) {
      const dir = path.join(presetsDir, entry.dir);
      const parsed = parseSkillDir(dir);
      expect(parsed, `${entry.dir}: SKILL.md 应可解析`).not.toBeNull();
      const scan = scanSkillDir(dir, parsed);
      // vendored 原文不做宿主适配——partial 意味着上游文本出现了本宿主不提供
      // 的能力词，此时应修上游适配而非放宽此断言
      expect(scan.compatibility, `${entry.id}: ${scan.compatibilityReasons.join('; ')}`).toBe(
        'compatible',
      );
    }
    // 再分发依据三要素：来源、锚点 commit（40 位十六进制）、许可
    expect(notice).toContain('vendored');
    expect(notice).toContain('github.com/opendatalab/MinerU');
    expect(notice).toMatch(/[0-9a-f]{40}/);
    expect(notice).toContain('AGPL-3.0');
  });
});
