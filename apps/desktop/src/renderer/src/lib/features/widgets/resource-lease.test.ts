import { describe, expect, test } from 'vitest';

import { WidgetResourceLease } from './resource-lease';

/**
 * 资源租约（D81 审查修复）：卡片闲置超过 core 资源 TTL / 被 LRU 淘汰后，桥调用得
 * WIDGET_RESOURCE_EXPIRED——租约重开换新 id 并重放这次调用，写入不丢；并发过期共用
 * 一次重开；重开失败只通知一次并以原错误失败；关闭后迟到的重开结果被释放。
 */

const expired = (): Error => Object.assign(new Error('组件界面已过期'), { code: 'WIDGET_RESOURCE_EXPIRED' });

function harness(options?: { reopenFails?: boolean }) {
  const reopened: string[] = [];
  const discarded: string[] = [];
  const failures: unknown[] = [];
  let next = 1;
  let release: (() => void) | null = null;
  const lease = new WidgetResourceLease({
    resourceId: 'res_0',
    reopen: async () => {
      if (options?.reopenFails === true) {
        throw Object.assign(new Error('这个版本的组件已不存在'), { code: 'WIDGET_INVALID' });
      }
      // 可选：让测试控制重开何时完成（模拟并发 / 关闭竞态）。
      if (release !== null) await new Promise<void>((resolve) => (release = resolve));
      const id = `res_${next++}`;
      reopened.push(id);
      return id;
    },
    discard: (id) => discarded.push(id),
    onRenewFailed: (error) => failures.push(error),
  });
  return {
    lease,
    reopened,
    discarded,
    failures,
    holdReopen: () => {
      release = () => undefined;
    },
    finishReopen: () => release?.(),
  };
}

/** 模拟 core：只有 `live` 里的 id 可用，其余一律过期。 */
function coreWith(live: Set<string>, seen: string[]) {
  return async (resourceId: string): Promise<string> => {
    seen.push(resourceId);
    if (!live.has(resourceId)) throw expired();
    return `ok:${resourceId}`;
  };
}

describe('WidgetResourceLease', () => {
  test('未过期：直接用当前 id，不重开', async () => {
    const h = harness();
    const seen: string[] = [];
    await expect(h.lease.call(coreWith(new Set(['res_0']), seen))).resolves.toBe('ok:res_0');
    expect(h.reopened).toEqual([]);
  });

  test('过期：重开换新 id 并重放这次调用（写入不丢），之后的调用沿用新 id', async () => {
    const h = harness();
    const seen: string[] = [];
    const live = new Set(['res_1']);
    await expect(h.lease.call(coreWith(live, seen))).resolves.toBe('ok:res_1');
    expect(seen).toEqual(['res_0', 'res_1']);
    expect(h.lease.resourceId).toBe('res_1');
    await expect(h.lease.call(coreWith(live, seen))).resolves.toBe('ok:res_1');
    expect(h.reopened).toEqual(['res_1']);
  });

  test('并发的过期调用共用一次重开', async () => {
    const h = harness();
    const seen: string[] = [];
    const live = new Set(['res_1']);
    const results = await Promise.all([
      h.lease.call(coreWith(live, seen)),
      h.lease.call(coreWith(live, seen)),
      h.lease.call(coreWith(live, seen)),
    ]);
    expect(results).toEqual(['ok:res_1', 'ok:res_1', 'ok:res_1']);
    expect(h.reopened).toEqual(['res_1']);
  });

  test('非过期错误原样抛出，不重开', async () => {
    const h = harness();
    const failing = async (): Promise<string> => {
      throw Object.assign(new Error('存储满了'), { code: 'WIDGET_STORAGE_QUOTA' });
    };
    await expect(h.lease.call(failing)).rejects.toMatchObject({ code: 'WIDGET_STORAGE_QUOTA' });
    expect(h.reopened).toEqual([]);
  });

  test('重开失败（组件已删除）：通知一次并以原过期错误失败', async () => {
    const h = harness({ reopenFails: true });
    const seen: string[] = [];
    await expect(
      Promise.all([h.lease.call(coreWith(new Set(), seen)), h.lease.call(coreWith(new Set(), seen))]),
    ).rejects.toMatchObject({ code: 'WIDGET_RESOURCE_EXPIRED' });
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toMatchObject({ code: 'WIDGET_INVALID' });
  });

  test('关闭后：拒绝新调用；迟到的重开结果被释放，不复活租约', async () => {
    const h = harness();
    h.holdReopen();
    const seen: string[] = [];
    const pending = h.lease.call(coreWith(new Set(['res_1']), seen));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.lease.close()).toBe('res_0');
    expect(h.lease.close()).toBeNull();
    h.finishReopen();
    await expect(pending).rejects.toMatchObject({ code: 'WIDGET_RESOURCE_EXPIRED' });
    expect(h.discarded).toEqual(['res_1']);
    expect(h.failures).toEqual([]);
    await expect(h.lease.call(coreWith(new Set(['res_1']), seen))).rejects.toThrow('组件界面已关闭');
  });
});
