import { RELAY_ANCHOR_TTL_MS } from './envelope';

/**
 * Worker 侧每 IP 并发会话上限(设计 §4.3「每 IP 并发会话数上限」)。独立成模块:
 * workerd 要求入口模块的具名导出只能是 handler 函数或绑定的 DO 类,数字/类导出
 * 会让 runtime 拒载(WP6 本地联调发现),测试从这里导入。
 */

export const MAX_SESSIONS_PER_IP = 10;

/**
 * per-IP 会话名额(每 isolate 一份)。Worker 把 DO 返回的 101 直通浏览器后
 * 观察不到连接关闭,名额无法在关闭时递减:改为按会话最长寿命(anchor TTL)过期,
 * 近似「并发」上限。名额键是会话 sid:同一会话的重连(手机网络闪断 / 页面刷新)
 * 幂等续期、不占新名额——WP6 联调发现按连接计名额会在 10 分钟内第 11 次重连时
 * 把正常用户锁在门外,与会话上限语义相悖。
 */
export class IpSessionLimiter {
  /** ip → (会话 sid → 过期时刻 ms)。 */
  private readonly slots = new Map<string, Map<string, number>>();
  /** 上次全表清扫时刻:全表清扫每 TTL 至多一次,避免每次 acquire 都 O(全表)。 */
  private lastSweepAt = 0;

  constructor(
    private readonly limit: number = MAX_SESSIONS_PER_IP,
    private readonly ttlMs: number = RELAY_ANCHOR_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** 记一次会话占用;先清扫过期名额,超限返回 false。同 sid 重连幂等续期。 */
  acquire(ip: string, sid: string): boolean {
    const now = this.now();
    // 借 acquire 之机周期性全表清扫:消失的 IP(电梯里换出口、NAT 轮换)留下的
    // 空表项也要回收(审查修复;原先只清当前 IP)。
    if (now - this.lastSweepAt >= this.ttlMs) {
      this.lastSweepAt = now;
      for (const [key, entries] of this.slots) {
        for (const [k, expiresAt] of entries) {
          if (expiresAt <= now) entries.delete(k);
        }
        if (entries.size === 0) this.slots.delete(key);
      }
    }
    let entries = this.slots.get(ip);
    if (!entries) {
      entries = new Map();
      this.slots.set(ip, entries);
    }
    for (const [k, expiresAt] of entries) {
      if (expiresAt <= now) entries.delete(k);
    }
    if (!entries.has(sid) && entries.size >= this.limit) return false;
    entries.set(sid, now + this.ttlMs);
    return true;
  }

  /** 该 IP 的活跃名额数(已过期的不计;测试与诊断用)。 */
  active(ip: string): number {
    const entries = this.slots.get(ip);
    if (!entries) return 0;
    const now = this.now();
    let count = 0;
    for (const expiresAt of entries.values()) if (expiresAt > now) count += 1;
    return count;
  }
}
