import { describe, expect, it } from 'vitest';
import { PROVIDER_TEMPLATES } from '@kepcup/shared';
import { providerIcon } from './provider-logos';

/**
 * 供应商图标映射：模板 `logo` 键必须都能解析到打包内图标（新增模板漏登记
 * 会在设置页静默掉回首字母），单色标记必须标成 mono——标错会在暗色主题下
 * 变成黑块。
 */
describe('provider icons', () => {
  it('every template logo resolves to a packaged icon', () => {
    for (const template of PROVIDER_TEMPLATES) {
      if (template.logo === undefined) continue;
      const icon = providerIcon(template.logo);
      expect(icon, template.id).toBeDefined();
      expect(icon?.url.length ?? 0, template.id).toBeGreaterThan(0);
    }
  });

  it('unknown / empty keys have no icon so callers fall back to the initial', () => {
    expect(providerIcon(undefined)).toBeUndefined();
    expect(providerIcon('')).toBeUndefined();
    expect(providerIcon('model-provider-does-not-exist.png')).toBeUndefined();
  });
});
