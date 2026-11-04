import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { validateMicroAppManifest } from '../../src/micro-apps/manifest.js';
import { runWidgetCheck } from '../../src/widgets/check/index.js';
import { WIDGET_TEMPLATES } from '../../src/widgets/templates/index.js';

/**
 * 三个微应用包模板（D112 P3）能被清单校验器解析且 GATE 零 error 级问题（P3 审查修复
 * P2-11：此前只有 voice-tutor 被 e2e 顺带覆盖）。
 */

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SPEC = '> 模板\n成本：每轮 100 token\n联网：不联网';

describe('微应用包模板', () => {
  for (const name of ['micro-voice-tutor', 'micro-form-intake', 'micro-data-board']) {
    test(`${name}：清单合法 + GATE 无 error`, async () => {
      const template = WIDGET_TEMPLATES.find((item) => item.name === name)!;
      expect(template).toBeDefined();
      const manifest = validateMicroAppManifest(JSON.parse(template.manifestJson!), template.html);
      expect(manifest.manifest.permissions.length).toBeGreaterThan(0);
      const dir = mkdtempSync(path.join(tmpdir(), `micro-template-${name}-`));
      dirs.push(dir);
      writeFileSync(path.join(dir, 'index.html'), template.html);
      writeFileSync(path.join(dir, 'micro-app.json'), template.manifestJson!);
      if (template.fixtures !== undefined) {
        writeFileSync(path.join(dir, 'fixtures.json'), JSON.stringify(template.fixtures));
      }
      if (template.queries !== undefined) {
        writeFileSync(path.join(dir, 'queries.json'), JSON.stringify(template.queries));
      }
      writeFileSync(path.join(dir, 'spec.md'), SPEC);
      const report = await runWidgetCheck({ draftDir: dir, validateQueries: () => null, now: Date.now() });
      const errors = report.issues.filter((issue) => issue.level === 'error');
      expect(errors, JSON.stringify(report.issues)).toEqual([]);
      expect(report.verdict).not.toBe('blocked');
    });
  }
});
