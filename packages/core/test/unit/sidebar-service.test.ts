import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { SIDEBAR_UNASSIGNED_ID, type SidebarLayout } from '@kepcup/shared';
import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import type { Clock } from '../../src/infra/clock.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { SidebarService } from '../../src/domain/sidebar.js';

/**
 * main 0065：左栏对话分组（sidebar_sections / conversation_sidebar）。
 * 内置「未指定」是真实行（参与顺序与折叠，但不能改名 / 删除）；会话归属与置顶
 * 是稀疏偏好行，删分组回落「未指定」、删会话级联清掉。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'sidebar-service-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let db: SqliteDatabase;
let service: SidebarService;
let now = 1_000;

const clock: Clock = { now: () => now };

beforeEach(() => {
  db = openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  now = 1_000;
  service = new SidebarService(db, clock);
  for (const id of ['conv_1', 'conv_2', 'conv_3']) {
    db.prepare("insert into conversations (id, type, created_at) values (?, 'direct', ?)").run(
      id,
      now,
    );
  }
});

function sectionIds(layout: SidebarLayout): string[] {
  return layout.order;
}

describe('SidebarService', () => {
  it('缺省只有内置「未指定」', () => {
    const layout = service.layout();
    expect(layout.sections).toEqual([]);
    expect(layout.order).toEqual([SIDEBAR_UNASSIGNED_ID]);
    expect(layout.assignments).toEqual({});
    expect(layout.collapsed).toEqual({});
    expect(layout.pinned).toEqual({});
  });

  it('新建分组排到最前，并可在同一次调用里归类', () => {
    const first = service.create({ id: 'ssc_work', name: '  工作  ', conversationId: 'conv_1' });
    expect(first.sectionId).toBe('ssc_work');
    expect(first.layout.sections).toEqual([{ id: 'ssc_work', name: '工作' }]);
    expect(first.layout.order).toEqual(['ssc_work', SIDEBAR_UNASSIGNED_ID]);
    expect(first.layout.assignments).toEqual({ conv_1: 'ssc_work' });

    const second = service.create({ id: 'ssc_life', name: '生活' });
    expect(second.layout.order).toEqual(['ssc_life', 'ssc_work', SIDEBAR_UNASSIGNED_ID]);
    // 未指定仍留在顺序里
    expect(sectionIds(second.layout)).toContain(SIDEBAR_UNASSIGNED_ID);
  });

  it('重命名去空白；「未指定」不能改名或删除；未知 id 报 NOT_FOUND', () => {
    service.create({ id: 'ssc_work', name: '工作' });
    expect(service.rename('ssc_work', ' 项目 ').sections).toEqual([
      { id: 'ssc_work', name: '项目' },
    ]);
    expect(() => service.rename(SIDEBAR_UNASSIGNED_ID, 'x')).toThrow(/未指定/);
    expect(() => service.remove(SIDEBAR_UNASSIGNED_ID)).toThrow(/未指定/);
    expect(() => service.rename('missing', 'x')).toThrow(/不存在/);
  });

  it('删分组后组内会话回到「未指定」；删掉最后一个分组时清掉未指定的折叠', () => {
    service.create({ id: 'ssc_work', name: '工作', conversationId: 'conv_1' });
    service.setCollapsed(SIDEBAR_UNASSIGNED_ID, true);
    const layout = service.remove('ssc_work');
    expect(layout.sections).toEqual([]);
    expect(layout.assignments).toEqual({});
    expect(layout.order).toEqual([SIDEBAR_UNASSIGNED_ID]);
    expect(layout.collapsed).toEqual({});
  });

  it('排序包含「未指定」，落回原位不写库', () => {
    service.create({ id: 'ssc_a', name: '甲' });
    service.create({ id: 'ssc_b', name: '乙' });
    expect(service.layout().order).toEqual(['ssc_b', 'ssc_a', SIDEBAR_UNASSIGNED_ID]);

    expect(service.move(SIDEBAR_UNASSIGNED_ID, 'ssc_b').order).toEqual([
      SIDEBAR_UNASSIGNED_ID,
      'ssc_b',
      'ssc_a',
    ]);
    expect(service.move('ssc_a', null).order).toEqual([SIDEBAR_UNASSIGNED_ID, 'ssc_b', 'ssc_a']);
    // 已经在其后：不动
    expect(service.move(SIDEBAR_UNASSIGNED_ID, 'ssc_b').order).toEqual([
      SIDEBAR_UNASSIGNED_ID,
      'ssc_b',
      'ssc_a',
    ]);
    expect(() => service.move('ssc_a', 'missing')).toThrow(/目标分组/);
    expect(() => service.move('missing', null)).toThrow(/不存在/);
  });

  it('折叠可持久化；移进折叠的分组会自动展开', () => {
    service.create({ id: 'ssc_a', name: '甲' });
    service.setCollapsed('ssc_a', true);
    service.setCollapsed(SIDEBAR_UNASSIGNED_ID, true);
    expect(service.layout().collapsed).toEqual({
      ssc_a: true,
      [SIDEBAR_UNASSIGNED_ID]: true,
    });

    const assigned = service.assign('conv_1', 'ssc_a');
    expect(assigned.collapsed).toEqual({ [SIDEBAR_UNASSIGNED_ID]: true });
    expect(assigned.assignments).toEqual({ conv_1: 'ssc_a' });

    // 用户移回未指定会展开它；后台清理（unassign）不展开。
    expect(service.assign('conv_1', null).collapsed).toEqual({});
    service.setCollapsed(SIDEBAR_UNASSIGNED_ID, true);
    const cleaned = service.unassign('conv_1');
    expect(cleaned.assignments).toEqual({});
    expect(cleaned.collapsed).toEqual({ [SIDEBAR_UNASSIGNED_ID]: true });

    expect(service.setCollapsed(SIDEBAR_UNASSIGNED_ID, false).collapsed).toEqual({});
    expect(() => service.setCollapsed('missing', true)).toThrow(/不存在/);
  });

  it('归属与置顶是稀疏行：移回未指定且未置顶时删行', () => {
    service.create({ id: 'ssc_a', name: '甲' });
    service.assign('conv_1', 'ssc_a');
    service.setPinned('conv_1', true);
    let layout = service.layout();
    expect(layout.assignments).toEqual({ conv_1: 'ssc_a' });
    expect(layout.pinned).toEqual({ conv_1: true });

    service.assign('conv_1', null);
    layout = service.layout();
    expect(layout.assignments).toEqual({});
    expect(layout.pinned).toEqual({ conv_1: true });

    service.setPinned('conv_1', false);
    expect(db.prepare('select count(*) as n from conversation_sidebar').get()).toEqual({ n: 0 });
  });

  it('未知会话或分组写入报错', () => {
    expect(() => service.assign('conv_missing', null)).toThrow(/会话不存在/);
    expect(() => service.setPinned('conv_missing', true)).toThrow(/会话不存在/);
    expect(() => service.assign('conv_1', 'missing')).toThrow(/目标分组/);
    expect(() => service.create({ name: 'x', conversationId: 'conv_missing' })).toThrow(
      /会话不存在/,
    );
  });

  it('物理删除会话时偏好行级联清掉', () => {
    service.create({ id: 'ssc_a', name: '甲', conversationId: 'conv_1' });
    db.prepare('delete from conversations where id = ?').run('conv_1');
    expect(service.layout().assignments).toEqual({});
    expect(db.prepare('select count(*) as n from conversation_sidebar').get()).toEqual({ n: 0 });
  });

  it('旧 localStorage 数据只在库为空时导入一次，坏条目丢弃', () => {
    const imported = service.importLayout({
      sections: [
        { id: 'sec_old', name: '旧分组' },
        { id: SIDEBAR_UNASSIGNED_ID, name: '冒名' },
        { id: 'sec_old', name: '重复' },
        { id: 'sec_empty', name: '' },
      ],
      order: ['sec_old', SIDEBAR_UNASSIGNED_ID, 'sec_ghost'],
      assignments: { conv_1: 'sec_old', conv_2: 'sec_ghost', conv_missing: 'sec_old' },
      collapsed: { sec_old: true, sec_ghost: true, [SIDEBAR_UNASSIGNED_ID]: true },
      pinned: { conv_2: true, conv_missing: true },
    });

    expect(imported.imported).toBe(true);
    expect(imported.layout.sections).toEqual([{ id: 'sec_old', name: '旧分组' }]);
    expect(imported.layout.order).toEqual(['sec_old', SIDEBAR_UNASSIGNED_ID]);
    // 指向已删除分组的归属被丢掉；不存在的会话不落行
    expect(imported.layout.assignments).toEqual({ conv_1: 'sec_old' });
    expect(imported.layout.collapsed).toEqual({
      sec_old: true,
      [SIDEBAR_UNASSIGNED_ID]: true,
    });
    expect(imported.layout.pinned).toEqual({ conv_2: true });

    // 第二次导入不再生效（库里已有分组状态）
    const again = service.importLayout({
      sections: [{ id: 'sec_other', name: '不应导入' }],
      order: ['sec_other', SIDEBAR_UNASSIGNED_ID],
      assignments: {},
      collapsed: {},
      pinned: {},
    });
    expect(again.imported).toBe(false);
    expect(again.layout.sections).toEqual([{ id: 'sec_old', name: '旧分组' }]);
  });

  it('长度上限按 code point 截断（导入 / 建组共用 cleanName）', () => {
    const long = '😀'.repeat(60);
    const created = service.create({ id: 'ssc_long', name: long });
    expect([...(created.layout.sections[0]?.name ?? '')].length).toBe(40);
  });
});
