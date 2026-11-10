import { targetId, targetLabel, type ConnectTarget } from './connect';

/**
 * 最近连接的纯数据模型(D122 §3):首页三入口里的「最近连接」。持久化交给
 * targets.svelte.ts 的存储后端,这里只做列表变换(去重上浮 + 上限截断),便于
 * 纯 Node 测试。
 */

export interface RecentTarget {
  id: string;
  kind: 'pairing' | 'server';
  /** 展示名(host:port;配对目标为中转/扫码源 host)。 */
  label: string;
  /** 原始目标文本(配对链接整条 / 服务地址),连接时重新解析构建。 */
  raw: string;
  addedAt: number;
  lastUsedAt: number;
}

/** 列表上限:遥控场景高频目标就两三台,8 条足够,防止无限增长。 */
export const RECENT_TARGETS_CAP = 8;

export function toRecentTarget(target: ConnectTarget, now: number): RecentTarget {
  return {
    id: targetId(target),
    kind: target.kind,
    label: targetLabel(target),
    raw: target.kind === 'pairing' ? target.sourceUrl : target.url,
    addedAt: now,
    lastUsedAt: now,
  };
}

/**
 * 上浮插入:同 id 移到最前并更新 lastUsedAt(addedAt 保留首次时间),新条目插头,
 * 超上限从尾部截断。返回新数组(纯函数,不修改入参)。
 */
export function upsertRecent(
  list: RecentTarget[],
  entry: RecentTarget,
  cap: number = RECENT_TARGETS_CAP,
): RecentTarget[] {
  const previous = list.find((item) => item.id === entry.id);
  const merged: RecentTarget =
    previous === undefined ? entry : { ...entry, addedAt: previous.addedAt };
  return [merged, ...list.filter((item) => item.id !== entry.id)].slice(0, cap);
}
