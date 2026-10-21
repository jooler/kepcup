import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const files = ['OnboardingWizard.svelte', 'NoModelBanner.svelte'];

describe('首启引导界面文案', () => {
  it('模板中没有硬编码中文（全部走 i18n）', () => {
    for (const file of files) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      const template = source
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '');
      expect(template, file).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });
});
