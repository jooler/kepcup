import { describe, expect, it } from 'vitest';
import { runtimeDisclosureView } from './plugin-runtime-disclosure';

/**
 * D125 P4 同意卡能力披露（61 §7）：执行型插件必须看到「可联网域名（含通配说明）/
 * 将请求的凭据字段名（不含值）/ 本地存储配额」三项；数据型插件返回 null（零变化）。
 */

describe('同意卡执行型能力披露（D125 P4）', () => {
  it('数据型插件（runtime null / undefined）不渲染披露区块', () => {
    expect(runtimeDisclosureView(null)).toBeNull();
    expect(runtimeDisclosureView(undefined)).toBeNull();
  });

  it('联网域名逐条列出；通配条目置 networkWildcard（面板追加「* 匹配子域」说明）', () => {
    const view = runtimeDisclosureView({
      hostApi: '^1',
      networkDomains: ['dashscope.aliyuncs.com', '*.aliyuncs.com'],
      credentialFields: ['apiKey'],
      storageQuotaBytes: 10 * 1024 * 1024,
    });
    expect(view).toEqual({
      networkDomains: ['dashscope.aliyuncs.com', '*.aliyuncs.com'],
      networkWildcard: true,
      credentialFields: ['apiKey'],
      storageQuotaBytes: 10 * 1024 * 1024,
    });
  });

  it('精确域名不含通配说明；无凭据 / 无域名时为空数组（面板显示对应说明文案）', () => {
    const view = runtimeDisclosureView({
      hostApi: '^1',
      networkDomains: ['example.invalid'],
      credentialFields: [],
      storageQuotaBytes: 1024,
    });
    expect(view?.networkWildcard).toBe(false);
    expect(view?.credentialFields).toEqual([]);
    expect(view?.networkDomains).toEqual(['example.invalid']);
  });

  it('不回传凭据值：视图只取字段名（数据面本身也不含值）', () => {
    const view = runtimeDisclosureView({
      hostApi: '^1',
      networkDomains: [],
      credentialFields: ['apiKey', 'secretKey'],
      storageQuotaBytes: 1,
    });
    expect(JSON.stringify(view)).not.toContain('sk-');
    expect(view?.credentialFields).toEqual(['apiKey', 'secretKey']);
  });
});
