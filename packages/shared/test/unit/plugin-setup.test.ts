import { describe, expect, it } from 'vitest';
import { capabilityOfTool } from '../../src/domain/host-capabilities.js';
import { setupRequirementSchema } from '../../src/domain/types.js';

/**
 * D104 P1-3：Bot 提议安装插件的设置需求。
 *
 * 契约形状固定（`confirm-plugin-install`），渲染端的 Bot 确认卡与 core 的
 * `plugins.inspect` 都只认这一份；插件工具**不进任何 ACP 能力包**——外部智能体拿不到。
 */
describe('confirm-plugin-install setup requirement', () => {
  const valid = {
    kind: 'confirm-plugin-install' as const,
    pluginId: 'io.github.alice/doc-tools',
    version: '1.2.0',
    name: '文档工具集',
    reason: '需要它来批量转换 PDF',
  };

  it('往返解析', () => {
    expect(setupRequirementSchema.parse(valid)).toEqual(valid);
  });

  it('缺字段被拒', () => {
    const { reason: _reason, ...missing } = valid;
    expect(setupRequirementSchema.safeParse(missing).success).toBe(false);
  });

  it('多余字段被拒', () => {
    expect(setupRequirementSchema.safeParse({ ...valid, sha256: 'a'.repeat(64) }).success).toBe(
      false,
    );
  });

  it('pluginId 过短 / 超长被拒', () => {
    expect(setupRequirementSchema.safeParse({ ...valid, pluginId: 'ab' }).success).toBe(false);
    expect(
      setupRequirementSchema.safeParse({ ...valid, pluginId: `a/${'b'.repeat(200)}` }).success,
    ).toBe(false);
  });

  it('name 非空、reason ≤300', () => {
    expect(setupRequirementSchema.safeParse({ ...valid, name: '' }).success).toBe(false);
    expect(setupRequirementSchema.safeParse({ ...valid, reason: 'x'.repeat(301) }).success).toBe(
      false,
    );
  });

  it('插件工具不属于任何 ACP 能力包', () => {
    expect(capabilityOfTool('plugin_search')).toBeNull();
    expect(capabilityOfTool('plugin_request_install')).toBeNull();
  });
});
