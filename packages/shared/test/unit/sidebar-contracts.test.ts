import { describe, expect, it } from 'vitest';
import {
  SIDEBAR_SECTION_NAME_MAX_CHARS,
  SIDEBAR_UNASSIGNED_ID,
  sidebarLayoutSchema,
} from '../../src/domain/sidebar.js';
import { rpcMethodSchemas } from '../../src/rpc/methods.js';

/**
 * 左栏分组契约（design/12「对话分组」）：`sidebar.get` / 每次写入都返回同一份
 * 投影；名称上限与「未指定」常量在这里收口。
 */

const layout = {
  sections: [{ id: 'ssc_work', name: '工作' }],
  order: ['ssc_work', SIDEBAR_UNASSIGNED_ID],
  assignments: { conv_1: 'ssc_work' },
  collapsed: { ssc_work: true },
  pinned: { conv_1: true },
};

describe('sidebarLayoutSchema', () => {
  it('接受完整投影', () => {
    expect(sidebarLayoutSchema.parse(layout)).toEqual(layout);
  });

  it('拒绝空名、超长名与空键', () => {
    expect(
      sidebarLayoutSchema.safeParse({
        ...layout,
        sections: [{ id: 'ssc_work', name: '' }],
      }).success,
    ).toBe(false);
    expect(
      sidebarLayoutSchema.safeParse({
        ...layout,
        sections: [{ id: 'ssc_work', name: 'x'.repeat(SIDEBAR_SECTION_NAME_MAX_CHARS + 1) }],
      }).success,
    ).toBe(false);
  });
});

describe('sidebar RPC inputs', () => {
  it('建组名称去空白并可带 conversationId', () => {
    expect(
      rpcMethodSchemas['sidebar.sections.create'].input.parse({
        name: '  工作  ',
        conversationId: 'conv_1',
      }),
    ).toEqual({ name: '工作', conversationId: 'conv_1' });
  });

  it('归属允许 null（移回未指定）；置顶是显式布尔', () => {
    expect(
      rpcMethodSchemas['sidebar.assign'].input.parse({
        conversationId: 'conv_1',
        sectionId: null,
      }),
    ).toEqual({ conversationId: 'conv_1', sectionId: null });
    expect(
      rpcMethodSchemas['sidebar.pin'].input.safeParse({ conversationId: 'conv_1' }).success,
    ).toBe(false);
  });

  it('导入只接受完整投影；输出带 imported 标志', () => {
    expect(rpcMethodSchemas['sidebar.import'].input.parse({ layout })).toEqual({ layout });
    expect(rpcMethodSchemas['sidebar.import'].output.parse({ layout, imported: true })).toEqual({
      layout,
      imported: true,
    });
  });
});
