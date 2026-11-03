import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../src/errors.js';
import {
  MICRO_APP_API_METHODS,
  MICRO_APP_CAPABILITIES,
  MICRO_APP_CAPABILITY_IDS,
  MICRO_APP_ERROR_HINTS,
  MICRO_APP_IMPLEMENTED_CAPABILITIES,
  MICRO_APP_MCP_APPS_METHOD_MAP,
  MICRO_APP_SDK_MARKER,
  MICRO_APP_SPEC_VERSION,
  microAppCapabilityOf,
} from '../../src/micro-app-sdk/spec.js';
import {
  MICRO_APP_SDK_REFERENCES,
  buildMicroAppDts,
  buildMicroAppSdkMd,
  buildMicroAppShim,
  microAppImplementedApiMethods,
  microAppPreviewMockSpec,
} from '../../src/micro-app-sdk/generate.js';
import {
  microAppCapabilityFingerprint,
  microAppManifestSchema,
  microAppUnimplementedCapabilities,
} from '../../src/domain/micro-app.js';

/**
 * 生成物守卫测试（设计 55 §6.1 / §14 P0）：spec 是唯一事实来源，生成物从它派生——
 * 这里守住「大小、引用存在、白名单一致、错误码已注册」这些构造上无法自动成立的约束。
 */

describe('micro-app-sdk spec（单一事实来源）', () => {
  it('能力 id 闭合且不重复；net.fetch 不在枚举里（由 net.mode 表达）', () => {
    expect(new Set(MICRO_APP_CAPABILITY_IDS).size).toBe(MICRO_APP_CAPABILITY_IDS.length);
    expect(MICRO_APP_CAPABILITY_IDS).not.toContain('net.fetch');
    for (const cap of MICRO_APP_CAPABILITIES) {
      expect(cap.userLine.length).toBeGreaterThan(0);
      expect(cap.limits.length).toBeGreaterThan(0);
      expect(cap.api.length).toBeGreaterThan(0);
    }
  });

  it('API 索引里每个方法的能力归属都在闭合枚举里或是 platform', () => {
    for (const method of MICRO_APP_API_METHODS) {
      if (method.capability === 'platform') continue;
      expect(MICRO_APP_CAPABILITY_IDS).toContain(method.capability);
    }
  });

  it('每个能力声明的 api 方法都在 API 索引里（两份清单互查）', () => {
    const declared = new Set(MICRO_APP_API_METHODS.map((m) => m.method));
    for (const cap of MICRO_APP_CAPABILITIES) {
      for (const method of cap.api) expect(declared.has(method)).toBe(true);
    }
  });

  it('错误 hint 的 code 都已注册进 ERROR_CODES（code + hint 同源）', () => {
    const registered = new Set<string>(ERROR_CODES);
    for (const hint of MICRO_APP_ERROR_HINTS) {
      expect(registered.has(hint.code)).toBe(true);
      // 教学式错误：hint 必须包含「下一步」的可执行指引，不是一句状态描述。
      expect(hint.hint.length).toBeGreaterThan(20);
      expect(hint.hint).toMatch(/：|。/);
    }
  });

  it('MCP Apps 映射表只引用已声明的桥方法', () => {
    const declared = new Set(MICRO_APP_API_METHODS.map((m) => m.method));
    declared.add('setHeight'); // v1 组件垫片的方法（映射表为其保留）。
    for (const method of Object.keys(MICRO_APP_MCP_APPS_METHOD_MAP)) {
      expect(declared.has(method)).toBe(true);
    }
    for (const name of Object.values(MICRO_APP_MCP_APPS_METHOD_MAP)) {
      expect(name.startsWith('ui/')).toBe(true);
    }
  });

  it('已实现能力集合是闭合枚举的子集', () => {
    const closed = new Set(MICRO_APP_CAPABILITY_IDS);
    for (const id of MICRO_APP_IMPLEMENTED_CAPABILITIES) expect(closed.has(id)).toBe(true);
  });
});

describe('micro-app-sdk 生成物', () => {
  it('sdk.md 入口 ≤4KB 且引用的 references 都在索引里且按阶段存在', () => {
    const md = buildMicroAppSdkMd('P0');
    expect(md.length).toBeLessThanOrEqual(4 * 1024);
    expect(md).toContain('信任边界');
    expect(md).toContain(MICRO_APP_SPEC_VERSION);
    const index = new Set(MICRO_APP_SDK_REFERENCES.map((r) => r.file));
    const referenced = [...md.matchAll(/`(references\/[a-z-]+\.md)`/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const file of referenced) expect(index.has(file)).toBe(true);
    // 入口不复制 references 的内容：引用文件名即可。
    for (const ref of MICRO_APP_SDK_REFERENCES) {
      if (ref.since === 'P0') expect(referenced).toContain(ref.file);
    }
  });

  it('垫片是单行、带指纹、不含 // 注释、不含 resourceId 字样', () => {
    const shim = buildMicroAppShim('dark');
    expect(shim).not.toContain('\n');
    expect(shim).toContain(MICRO_APP_SDK_MARKER);
    expect(shim).not.toContain('//');
    expect(shim.toLowerCase()).not.toContain('resourceid');
    expect(shim).toContain("'dark'");
    expect(buildMicroAppShim()).toContain("'light'");
  });

  it('d.ts 覆盖当前阶段实现的方法并带 JSDoc', () => {
    const dts = buildMicroAppDts();
    for (const method of microAppImplementedApiMethods()) {
      expect(dts).toContain(method);
    }
    expect(dts).toContain('AppReadyInfo');
    expect(dts).toContain('media.listen'); // P1 起进入。
    expect(dts).not.toContain('context.update'); // P2 起。
    expect(dts).not.toContain('collections.put'); // P2 起。
  });

  it('实现白名单：只含已实现能力与当前阶段平台方法（collections/context P2 起才进）', () => {
    const impl = microAppImplementedApiMethods();
    expect([...impl]).toContain('app.ready');
    expect([...impl]).toContain('storage.get');
    expect([...impl]).toContain('reply');
    expect([...impl]).toContain('media.listen');
    expect([...impl]).toContain('ai.chat');
    expect([...impl]).toContain('app.requestDisplayMode');
    expect([...impl]).not.toContain('collections.put');
    expect([...impl]).not.toContain('context.update');
    expect([...impl]).not.toContain('files.pick');
  });

  it('预览 mock 清单只引用索引里的方法', () => {
    const declared = new Set(MICRO_APP_API_METHODS.map((m) => m.method));
    for (const mock of microAppPreviewMockSpec()) expect(declared.has(mock.method)).toBe(true);
  });
});

describe('micro-app 清单 schema 与能力面指纹', () => {
  it('未知 spec / 未知能力 / 未知字段都拒绝（schema 是 strict 的，不静默忽略）', () => {
    const base = {
      spec: MICRO_APP_SPEC_VERSION,
      slug: 'english-corner',
      name: '小小英语角',
      entry: 'index.html',
      permissions: ['storage.kv'],
    };
    expect(microAppManifestSchema.safeParse(base).success).toBe(true);
    expect(microAppManifestSchema.safeParse({ ...base, spec: 'kepcup-micro-app/9' }).success).toBe(false);
    expect(microAppManifestSchema.safeParse({ ...base, permissions: ['storage.kv', 'nope'] }).success).toBe(false);
    expect(microAppManifestSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });

  it('net 缺省 open；allowlist 必须显式给域名数组', () => {
    const base = { spec: MICRO_APP_SPEC_VERSION, slug: 'a', name: 'A', entry: 'index.html' };
    const parsed = microAppManifestSchema.parse(base);
    expect(parsed.net.mode).toBe('open');
    expect(parsed.net.allowlist).toEqual([]);
    const tightened = microAppManifestSchema.parse({ ...base, net: { mode: 'allowlist', allowlist: ['a.com'] } });
    expect(tightened.net.mode).toBe('allowlist');
  });

  it('指纹 = 排序 permissions + net 档位 + 排序域名：扩大才变，纯代码更新不变', () => {
    const base = microAppCapabilityFingerprint(['storage.kv', 'host.reply'], { mode: 'open', allowlist: [] });
    expect(microAppCapabilityFingerprint(['host.reply', 'storage.kv'], { mode: 'open', allowlist: [] })).toBe(base);
    // 新增能力 → 变。
    expect(microAppCapabilityFingerprint(['storage.kv', 'host.reply', 'ai.chat'], { mode: 'open', allowlist: [] })).not.toBe(base);
    // 收紧网络 → 变（新版本，重新确认）。
    expect(microAppCapabilityFingerprint(['storage.kv', 'host.reply'], { mode: 'none', allowlist: [] })).not.toBe(base);
    // 域名集合扩大 → 变。
    const list = microAppCapabilityFingerprint(['storage.kv'], { mode: 'allowlist', allowlist: ['a.com', 'b.com'] });
    expect(microAppCapabilityFingerprint(['storage.kv'], { mode: 'allowlist', allowlist: ['b.com', 'a.com'] })).toBe(list);
    expect(microAppCapabilityFingerprint(['storage.kv'], { mode: 'allowlist', allowlist: ['a.com', 'b.com', 'c.com'] })).not.toBe(list);
    // none / open 档忽略域名（域名只对 allowlist 有意义）。
    expect(microAppCapabilityFingerprint(['storage.kv'], { mode: 'none', allowlist: ['a.com'] })).toBe(
      microAppCapabilityFingerprint(['storage.kv'], { mode: 'none', allowlist: [] }),
    );
  });

  it('未实现能力的声明会被点名（交付裁决）', () => {
    expect(microAppUnimplementedCapabilities(['storage.kv', 'host.reply', 'ai.chat', 'media.listen'])).toEqual([]);
    const missing = microAppUnimplementedCapabilities(['storage.kv', 'storage.collection']);
    expect(missing).toEqual(['storage.collection']);
    expect(microAppCapabilityOf('storage.collection')?.phase).toBe('P2');
  });
});
