import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import {
  MICRO_APP_BRIDGE_APP_SOURCE,
  MICRO_APP_BRIDGE_HOST_SOURCE,
  MICRO_APP_EVENT_SUBSCRIPTIONS_MAX,
  buildMicroAppShim,
} from '../../src/index.js';

/**
 * 微应用垫片的真实执行测试（审查修复 F5）：垫片是给作者 Bot 的运行时契约，只做字符串
 * 断言不够——在 node vm 里跑起来，与桥协议对端（host 帧形状）互演：ready 调用 / ack /
 * 事件订阅（theme 要真正派发到 app.on）/ 错误 code+hint / 订阅上限 / close 收口。
 */

interface SentFrame {
  v: number;
  source: string;
  k: string;
  [key: string]: unknown;
}

function loadShim(theme: 'light' | 'dark' = 'light'): {
  kepcup: {
    app: {
      ready(): Promise<unknown>;
      on(name: string, cb: (value?: unknown) => void): () => void;
      setTitle(title: string): void;
    };
    storage: {
      get(key: string): Promise<unknown>;
      set(key: string, value: unknown): Promise<void>;
      delete(key: string): Promise<void>;
      list(): Promise<string[]>;
    };
    query(name: string, params?: Record<string, unknown>): Promise<unknown>;
    openLink(url: string): Promise<void>;
    reply(text: string): Promise<boolean>;
    ui: { theme(): Promise<string> };
  };
  deliver(frame: Record<string, unknown>): void;
  sent: SentFrame[];
  appliedTheme: string;
  customEvents: Array<{ type: string; detail: unknown }>;
} {
  // 生成物就是运行时计算的；这里从源码目录读 spec 再生成一次没有意义，直接用导出函数。
  const source = buildMicroAppShim(theme).replace(/^<script>/, '').replace(/<\/script>$/, '');
  const sent: SentFrame[] = [];
  const messageHandlers: Array<(event: unknown) => void> = [];
  const state = {
    appliedTheme: '',
    customEvents: [] as Array<{ type: string; detail: unknown }>,
  };
  const parent = { postMessage: (msg: SentFrame) => sent.push(msg) };
  const documentElement = {
    setAttribute: (_name: string, value: string) => {
      state.appliedTheme = value;
    },
  };
  const windowObj: Record<string, unknown> = {
    addEventListener: (_type: string, cb: (event: unknown) => void) => messageHandlers.push(cb),
    dispatchEvent: (event: { type: string; detail: unknown }) => {
      state.customEvents.push(event);
      return true;
    },
  };
  windowObj['parent'] = parent;
  const realm = {
    window: windowObj,
    document: { documentElement },
    navigator: { userActivation: { isActive: true } },
    parent,
    CustomEvent: class {
      constructor(
        public type: string,
        public detail: unknown,
      ) {}
    },
    Promise,
    Map,
    Set,
    Symbol,
    Object,
    Array,
    JSON,
    Math,
    Error,
    Number,
    String,
    Boolean,
    Date,
    isFinite,
    setTimeout,
  };
  windowObj['kepcup'] = undefined;
  runInNewContext(source, realm);
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    kepcup: windowObj['kepcup'] as any,
    deliver: (frame: Record<string, unknown>) => {
      for (const handler of [...messageHandlers]) handler({ source: parent, data: frame });
    },
    sent,
    // getter：主题是可变状态（快照会在 load 时就被拷走）。
    get appliedTheme(): string {
      return state.appliedTheme;
    },
    customEvents: state.customEvents,
  };
}

const hostFrame = (frame: Record<string, unknown>): Record<string, unknown> => ({
  v: 2,
  source: MICRO_APP_BRIDGE_HOST_SOURCE,
  ...frame,
});

describe('微应用垫片（真实执行）', () => {
  test('app.ready 走 call 帧，ack 帧解析为结果', async () => {
    const shim = loadShim('dark');
    const ready = shim.kepcup.app.ready();
    expect(shim.sent).toEqual([
      {
        v: 2,
        source: MICRO_APP_BRIDGE_APP_SOURCE,
        k: 'call',
        id: 1,
        method: 'app.ready',
        params: {},
        stream: false,
      },
    ]);
    shim.deliver(hostFrame({ k: 'ack', id: 1, result: { capabilities: ['storage.kv'] } }));
    await expect(ready).resolves.toEqual({ capabilities: ['storage.kv'] });
  });

  test('error 帧解析为带 code 与 hint 的 Error', async () => {
    const shim = loadShim();
    const call = shim.kepcup.storage.get('k');
    shim.deliver(
      hostFrame({
        k: 'error',
        id: 1,
        code: 'MICRO_APP_CAPABILITY_NOT_DECLARED',
        message: '没有声明能力',
        hint: '把能力补进 permissions',
      }),
    );
    await expect(call).rejects.toMatchObject({
      code: 'MICRO_APP_CAPABILITY_NOT_DECLARED',
      hint: '把能力补进 permissions',
      message: '没有声明能力',
    });
  });

  test('theme 事件：data-theme 更新 + kepcup:theme CustomEvent + app.on 回调（审查修复 F2）', () => {
    const shim = loadShim('light');
    const seen: unknown[] = [];
    shim.kepcup.app.on('theme', (value) => seen.push(value));
    shim.deliver(hostFrame({ k: 'event', subId: 'app', name: 'theme', data: 'dark', seq: 1 }));
    expect(shim.appliedTheme).toBe('dark');
    expect(seen).toEqual(['dark']);
    expect(shim.customEvents.map((event) => event.type)).toEqual(['kepcup:theme']);
    // 回执 event-ack，且 seq 连续时不再发 bridge-reset。
    expect(shim.sent.filter((frame) => frame.k === 'event-ack')).toEqual([
      { v: 2, source: MICRO_APP_BRIDGE_APP_SOURCE, k: 'event-ack', subId: 'app', seq: 1 },
    ]);
    const resets: unknown[] = [];
    shim.kepcup.app.on('bridge-reset', (value) => resets.push(value));
    shim.deliver(hostFrame({ k: 'event', subId: 'app', name: 'pause', data: null, seq: 3 }));
    expect(resets).toHaveLength(1);
  });

  test('订阅上限：超过 32 个活跃订阅抛错，退订后恢复', () => {
    const shim = loadShim();
    const offs = Array.from({ length: MICRO_APP_EVENT_SUBSCRIPTIONS_MAX }, () =>
      shim.kepcup.app.on('tick', () => undefined),
    );
    expect(() => shim.kepcup.app.on('tick', () => undefined)).toThrow(/上限/);
    offs[0]!();
    expect(() => shim.kepcup.app.on('tick', () => undefined)).not.toThrow();
  });

  test('close 帧：在途调用以 MICRO_APP_BRIDGE_CLOSED 收口（不是「用户拒绝」）', async () => {
    const shim = loadShim();
    const call = shim.kepcup.storage.list();
    shim.deliver(hostFrame({ k: 'close', reason: 'backpressure' }));
    await expect(call).rejects.toMatchObject({ code: 'MICRO_APP_BRIDGE_CLOSED' });
  });

  test('app.setTitle 发通知帧（id 0，无回执等待）', () => {
    const shim = loadShim();
    shim.kepcup.app.setTitle('练习中');
    expect(shim.sent).toEqual([
      {
        v: 2,
        source: MICRO_APP_BRIDGE_APP_SOURCE,
        k: 'call',
        id: 0,
        method: 'app.setTitle',
        params: { title: '练习中' },
        stream: false,
      },
    ]);
  });

  test('reply 无用户手势时静默 false（不发帧）', async () => {
    const source = buildMicroAppShim().replace(/^<script>/, '').replace(/<\/script>$/, '');
    const sent: SentFrame[] = [];
    const parent = { postMessage: (msg: SentFrame) => sent.push(msg) };
    const windowObj: Record<string, unknown> = {
      addEventListener: () => undefined,
      dispatchEvent: () => true,
    };
    windowObj['parent'] = parent;
    runInNewContext(source, {
      window: windowObj,
      document: { documentElement: { setAttribute: () => undefined } },
      navigator: { userActivation: { isActive: false } },
      parent,
      CustomEvent: class {},
      Promise,
      Map,
      Set,
      Symbol,
      Object,
      Array,
      JSON,
      Math,
      Error,
      Number,
      String,
      Boolean,
      Date,
      isFinite,
      setTimeout,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kepcup = windowObj['kepcup'] as any;
    await expect(kepcup.reply('hi')).resolves.toBe(false);
    expect(sent).toHaveLength(0);
  });

  test('垫片折成单行后仍是合法 JS（与注入位置约束一致）', () => {
    const shim = buildMicroAppShim();
    expect(shim).not.toContain('\n');
    expect(shim).toContain('window.kepcup');
  });
});
