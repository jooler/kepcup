import { describe, expect, it } from 'vitest';
import { PROVIDER_TEMPLATES } from '@kepcup/shared';
import { providerIcon, providerIconForInstance } from './provider-logos';

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

/**
 * `logo` 是 v0.5.6 实例化才加的字段：更早创建的实例（含 legacy 迁移来的）
 * 只有 id，没有 logo。左栏曾经因此退化成「绿点 + 名字」，这里锁住按 id
 * 回落模板图标的行为。
 */
describe('provider icons for instances', () => {
  it('falls back to the template icon when the instance has no logo', () => {
    for (const template of PROVIDER_TEMPLATES) {
      const icon = providerIconForInstance({ id: template.id });
      expect(icon, template.id).toBeDefined();
      expect(icon, template.id).toEqual(providerIcon(template.logo));
    }
  });

  it('maps the Nth instance of a template (-2 / -3) to the same icon', () => {
    const base = providerIconForInstance({ id: 'dashscope' });
    expect(base).toBeDefined();
    expect(providerIconForInstance({ id: 'dashscope-2' })).toEqual(base);
    expect(providerIconForInstance({ id: 'opencode-go-chat-3' })).toEqual(
      providerIconForInstance({ id: 'opencode-go-chat' }),
    );
  });

  it('prefers the instance logo over the template fallback', () => {
    expect(providerIconForInstance({ id: 'dashscope', logo: 'model-provider-openai.png' })).toEqual(
      providerIcon('model-provider-openai.png'),
    );
    // 已下线的资产名解析不到，仍按 id 回落模板图标。
    expect(
      providerIconForInstance({ id: 'dashscope', logo: 'model-provider-removed.png' }),
    ).toEqual(providerIconForInstance({ id: 'dashscope' }));
  });

  it('claims the icon by baseUrl when the id carries no template (legacy custom instances)', () => {
    expect(
      providerIconForInstance({ id: 'custom:opencode', baseUrl: 'https://opencode.ai/zen/go/v1' }),
    ).toEqual(providerIconForInstance({ id: 'opencode-go-chat' }));
    // 尾部斜杠不影响
    expect(
      providerIconForInstance({ id: 'custom:zai', baseUrl: 'https://api.z.ai/api/paas/v4/' }),
    ).toEqual(providerIconForInstance({ id: 'zai-standard-api' }));
    expect(
      providerIconForInstance({ id: 'custom:mine', baseUrl: 'https://api.example.com/v1' }),
    ).toBeUndefined();
  });

  it('keeps the initial fallback for custom / unknown ids', () => {
    expect(providerIconForInstance({ id: 'custom:my-provider' })).toBeUndefined();
    expect(providerIconForInstance({ id: 'some-pi-provider' })).toBeUndefined();
  });
});
