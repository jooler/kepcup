import { describe, expect, it } from 'vitest';
import {
  BARGE_IN_ARM_DELAY_MS,
  BARGE_IN_POLL_MS,
  BARGE_IN_SUSTAIN_MS,
  createBargeInMonitor,
  type BargeInSession,
  type BargeInTimers,
} from './voice-barge-in';
import { SPEECH_LEVEL_THRESHOLD } from './voice-mode.svelte';

/**
 * 播报中语音打断（docs/design/53-voice-conversation.md 修订 v2 V2-5）的纯逻辑
 * 状态机：延迟武装（播放早停取消未到点武装）、电平 ≥ 阈值持续判定、一次性
 * 触发后自拆（先拆除后回调）、全路径拆除（含取消武装定时器与在途 open 的
 * 世代作废）、开流失败静默降级。开流 / 电平 / 时钟 / 计时器全部注入假实现；
 * 接线（响应式武装窗口、触发 → interruptSpeech + acquireRecording）在
 * Composer，需真实 DOM，不在单测内。
 */

const HI = SPEECH_LEVEL_THRESHOLD + 0.1; // 正常说话（≥ 阈值）
const LO = SPEECH_LEVEL_THRESHOLD - 0.1; // 静音底噪（< 阈值）

/** 微任务/宏任务排空（open 假实现的落地拍点）。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface TimerEntry {
  handler: () => void;
  repeating: boolean;
}

function createFakeTimers() {
  const pending = new Set<TimerEntry>();
  const delays: number[] = [];
  const timers: BargeInTimers = {
    timeout: (delayMs, handler) => {
      delays.push(delayMs);
      const entry: TimerEntry = { handler, repeating: false };
      pending.add(entry);
      return () => pending.delete(entry);
    },
    interval: (intervalMs, handler) => {
      delays.push(intervalMs);
      const entry: TimerEntry = { handler, repeating: true };
      pending.add(entry);
      return () => pending.delete(entry);
    },
  };
  return {
    timers,
    delays,
    /** 到点武装定时器齐发（到点即摘除）。 */
    fireTimeouts(): void {
      for (const entry of [...pending]) {
        if (entry.repeating) continue;
        pending.delete(entry);
        entry.handler();
      }
    },
    /** 推进一轮电平轮询（interval 回调不摘除）。 */
    tickPoll(): void {
      for (const entry of [...pending]) {
        if (entry.repeating) entry.handler();
      }
    },
    pendingCount(): number {
      return pending.size;
    },
  };
}

interface FakeSession extends BargeInSession {
  level: number;
  closed: boolean;
}

function createHarness() {
  const fake = createFakeTimers();
  let clock = 10_000;
  let openImpl: () => Promise<BargeInSession> = () => Promise.resolve(makeSession(LO));
  let openCount = 0;
  /** defaultOpen 产出的会话（断言 open 次数 / 会话释放状态用）。 */
  const opened: FakeSession[] = [];
  /** 会话释放 / 触发回调的先后记录（断言「自拆先于回调」）。 */
  const teardownLog: string[] = [];
  const triggers: number[] = [];

  function makeSession(level: number): FakeSession {
    const session: FakeSession = {
      level,
      closed: false,
      readLevel: () => session.level,
      close: () => {
        session.closed = true;
        teardownLog.push('close');
      },
    };
    return session;
  }

  const deps = {
    timers: fake.timers,
    now: () => clock,
    open: () => {
      openCount += 1;
      return openImpl();
    },
    onTrigger: () => {
      teardownLog.push('trigger');
      triggers.push(clock);
    },
  };

  return {
    deps,
    timers: fake,
    makeSession,
    /** 默认 open：创建 LO 电平会话并留存到 opened。 */
    defaultOpen(): void {
      openImpl = () => {
        const session = makeSession(LO);
        opened.push(session);
        return Promise.resolve(session);
      };
    },
    setOpen(impl: () => Promise<BargeInSession>): void {
      openImpl = impl;
    },
    opened,
    /** 最近一次 defaultOpen 产出的会话（严格索引检查下免去 opened[i] 的 undefined）。 */
    lastSession(): FakeSession {
      const session = opened[opened.length - 1];
      if (session === undefined) throw new Error('no opened session yet');
      return session;
    },
    openCount: () => openCount,
    triggers,
    teardownLog,
    advance(ms: number): void {
      clock += ms;
    },
  };
}

type Harness = ReturnType<typeof createHarness>;

/** 标准路径：arm → 延迟到点 → 开流落地 → 监听中（返回会话供调电平）。 */
async function armToListening(h: Harness) {
  h.defaultOpen();
  const monitor = createBargeInMonitor(h.deps);
  monitor.arm();
  h.timers.fireTimeouts();
  await flush();
  expect(monitor.stage()).toBe('listening');
  return { monitor, session: h.lastSession() };
}

describe('barge-in 常量（53 号修订 v2 V2-5 规格，真机可调）', () => {
  it('武装延迟 / 持续判定 / 轮询间隔（阈值复用 voice-mode 的 SPEECH_LEVEL_THRESHOLD）', () => {
    expect(BARGE_IN_ARM_DELAY_MS).toBe(500);
    expect(BARGE_IN_SUSTAIN_MS).toBe(200);
    expect(BARGE_IN_POLL_MS).toBe(100);
  });
});

describe('createBargeInMonitor（武装 / 触发 / 拆除状态机）', () => {
  it('延迟武装：arm 后先不开流，武装定时器到点才开流并起轮询', async () => {
    const h = createHarness();
    h.defaultOpen();
    const monitor = createBargeInMonitor(h.deps);
    expect(monitor.stage()).toBe('idle');

    monitor.arm();
    expect(monitor.stage()).toBe('arming');
    expect(h.timers.delays).toEqual([BARGE_IN_ARM_DELAY_MS]);
    expect(h.openCount()).toBe(0); // 500ms 内不开流（AEC 收敛期规避）

    h.timers.fireTimeouts();
    expect(h.openCount()).toBe(1);
    await flush();
    expect(monitor.stage()).toBe('listening');
    expect(h.lastSession().closed).toBe(false);
    expect(h.timers.pendingCount()).toBe(1); // 电平轮询在跑
  });

  it('播放早停：未到点的武装被取消，定时器到点不再开流', () => {
    const h = createHarness();
    const monitor = createBargeInMonitor(h.deps);
    monitor.arm();
    monitor.disarm(); // 播放早停 / 打断 / 退出：取消未到点武装
    expect(monitor.stage()).toBe('idle');
    expect(h.timers.pendingCount()).toBe(0);

    h.timers.fireTimeouts(); // 定时器已撤：不得开流
    expect(h.openCount()).toBe(0);
  });

  it('电平持续 ≥ 阈值 200ms 触发：首帧起算，恰好 200ms 那拍判定', async () => {
    const h = createHarness();
    const { monitor, session } = await armToListening(h);
    session.level = HI;

    h.timers.tickPoll(); // 首帧：段起点 = t0，不触发
    h.advance(100);
    h.timers.tickPoll(); // 100ms < 200ms：不触发
    expect(monitor.stage()).toBe('listening');
    h.advance(100);
    h.timers.tickPoll(); // 恰好 200ms：触发
    expect(monitor.stage()).toBe('idle'); // 触发即自拆
    expect(h.triggers).toHaveLength(1);
  });

  it('断续开口重计：持续段被低于阈值的帧打断即重新起算', async () => {
    const h = createHarness();
    const { monitor, session } = await armToListening(h);

    // t0 hi（起算）→ t0+100 lo（重置）→ t0+200 hi（重新起算）→ t0+300 不够 → t0+400 触发。
    session.level = HI;
    h.timers.tickPoll();
    h.advance(100);
    session.level = LO;
    h.timers.tickPoll();
    h.advance(100);
    session.level = HI;
    h.timers.tickPoll();
    h.advance(100);
    h.timers.tickPoll(); // 重新起算后仅 100ms
    expect(monitor.stage()).toBe('listening');
    h.advance(100);
    h.timers.tickPoll(); // 满 200ms：触发
    expect(monitor.stage()).toBe('idle');
    expect(h.triggers).toHaveLength(1);
  });

  it('阈值之下不触发：轮询多拍维持监听', async () => {
    const h = createHarness();
    const { monitor, session } = await armToListening(h);
    session.level = LO;
    for (let i = 0; i < 20; i += 1) {
      h.advance(BARGE_IN_POLL_MS);
      h.timers.tickPoll();
    }
    expect(monitor.stage()).toBe('listening');
    expect(h.triggers).toEqual([]);
  });

  it('恰好等于阈值也算开口（≥ 语义）', async () => {
    const h = createHarness();
    const { monitor, session } = await armToListening(h);
    session.level = SPEECH_LEVEL_THRESHOLD;
    h.timers.tickPoll();
    h.advance(BARGE_IN_SUSTAIN_MS);
    h.timers.tickPoll();
    expect(monitor.stage()).toBe('idle');
    expect(h.triggers).toHaveLength(1);
  });

  it('一次性触发：自拆（先释放会话）后才回调；此后电平再高也不重复触发', async () => {
    const h = createHarness();
    const { monitor, session } = await armToListening(h);
    session.level = HI;

    h.timers.tickPoll(); // 起算
    h.advance(BARGE_IN_SUSTAIN_MS);
    h.timers.tickPoll(); // 触发
    expect(h.triggers).toHaveLength(1);
    expect(session.closed).toBe(true);
    expect(h.timers.pendingCount()).toBe(0); // 轮询已撤
    expect(h.teardownLog).toEqual(['close', 'trigger']); // 自拆先于回调（回调时监听已不在）

    // 触发后残留拍点不再触发（一次性）。
    session.level = HI;
    h.advance(BARGE_IN_POLL_MS);
    h.timers.tickPoll();
    expect(h.triggers).toHaveLength(1);
    expect(monitor.stage()).toBe('idle');
  });

  it('拆除路径（listening 中 disarm）：会话释放 + 轮询撤除，之后可对下一播放阶段重新武装', async () => {
    const h = createHarness();
    const first = await armToListening(h);
    first.monitor.disarm(); // 播完 / 打断 / 退出 / 切会话 / 卸载统一走的拆除
    expect(first.session.closed).toBe(true);
    expect(h.timers.pendingCount()).toBe(0);
    expect(first.monitor.stage()).toBe('idle');
    expect(h.triggers).toEqual([]);

    // 下一播放阶段重新武装（disarm 幂等后 arm 必须可用）。
    h.defaultOpen();
    first.monitor.arm();
    h.timers.fireTimeouts();
    await flush();
    expect(first.monitor.stage()).toBe('listening');
    expect(h.opened).toHaveLength(2);
    expect(h.lastSession().closed).toBe(false);
  });

  it('在途 open 期间拆除：迟到的会话落地即释放，不接管监听、不起轮询', async () => {
    const h = createHarness();
    let resolveOpen!: (session: BargeInSession) => void;
    h.setOpen(
      () =>
        new Promise<BargeInSession>((resolve) => {
          resolveOpen = resolve;
        }),
    );
    const monitor = createBargeInMonitor(h.deps);
    monitor.arm();
    h.timers.fireTimeouts();
    expect(h.openCount()).toBe(1);
    monitor.disarm(); // open 还在途

    const late = h.makeSession(LO);
    resolveOpen(late);
    await flush();
    expect(late.closed).toBe(true); // 世代作废：立即释放，不留孤儿流
    expect(monitor.stage()).toBe('idle');
    expect(h.timers.pendingCount()).toBe(0);
  });

  it('disarm 幂等：重复拆除无害', async () => {
    const { monitor } = await armToListening(createHarness());
    expect(() => {
      monitor.disarm();
      monitor.disarm();
    }).not.toThrow();
    expect(monitor.stage()).toBe('idle');
  });

  it('开流失败静默降级：不触发、不起轮询、回 idle 可再武装（不 toast 不影响播报）', async () => {
    const h = createHarness();
    h.setOpen(() => Promise.reject(new Error('device busy')));
    const monitor = createBargeInMonitor(h.deps);
    monitor.arm();
    h.timers.fireTimeouts();
    await flush();
    expect(monitor.stage()).toBe('idle'); // 静默放弃本次监听
    expect(h.triggers).toEqual([]);
    expect(h.timers.pendingCount()).toBe(0);

    h.defaultOpen(); // 点麦克风打断始终可用；下一播放阶段监听照常尝试
    monitor.arm();
    h.timers.fireTimeouts();
    await flush();
    expect(monitor.stage()).toBe('listening');
  });
});

describe('createBargeInMonitor（审查补充：重入 / 同步抛错 / 单次释放）', () => {
  it('arm 重入被忽略：arming 或 listening 期间再 arm 不重复开流', async () => {
    const h = createHarness();
    h.defaultOpen();
    const monitor = createBargeInMonitor(h.deps);
    monitor.arm();
    monitor.arm(); // arming 中
    expect(monitor.stage()).toBe('arming');
    expect(h.timers.delays).toEqual([BARGE_IN_ARM_DELAY_MS]); // 只有一个武装定时器

    h.timers.fireTimeouts();
    await flush();
    expect(monitor.stage()).toBe('listening');
    monitor.arm(); // listening 中
    expect(monitor.stage()).toBe('listening');
    expect(h.openCount()).toBe(1);
    expect(h.timers.pendingCount()).toBe(1); // 只有一个轮询
  });

  it('open 同步抛错：与 reject 同一降级路径，异常不逃出定时器回调', async () => {
    const h = createHarness();
    h.setOpen(() => {
      throw new Error('sync boom');
    });
    const monitor = createBargeInMonitor(h.deps);
    monitor.arm();
    expect(() => h.timers.fireTimeouts()).not.toThrow();
    await flush();
    expect(monitor.stage()).toBe('idle');
    expect(h.triggers).toEqual([]);
    expect(h.timers.pendingCount()).toBe(0);
  });

  it('会话只释放一次：触发自拆后接线 cleanup 的 disarm 不再重复 close', async () => {
    const h = createHarness();
    const { monitor, session } = await armToListening(h);
    session.level = HI;
    h.timers.tickPoll();
    h.advance(BARGE_IN_SUSTAIN_MS);
    h.timers.tickPoll(); // 触发即自拆
    expect(h.teardownLog).toEqual(['close', 'trigger']);

    monitor.disarm(); // 接线 effect 的 cleanup（触发后相位已变，cleanup 迟到一拍）
    expect(h.teardownLog).toEqual(['close', 'trigger']); // 不重复 close
  });

  it('拆除后的轮询拍点不再触发', async () => {
    const h = createHarness();
    const { monitor, session } = await armToListening(h);
    session.level = HI;
    monitor.disarm();
    // 假 interval 已摘除：推进不会再回调；直接手工触发一次也无监听可读。
    h.timers.tickPoll();
    expect(h.triggers).toEqual([]);
    expect(monitor.stage()).toBe('idle');
  });
});
