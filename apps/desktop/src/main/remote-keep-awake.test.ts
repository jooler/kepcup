import { describe, expect, it } from 'vitest';
import {
  createRemoteKeepAwake,
  remoteConnectionAlive,
  type PowerSaveBlockerApi,
} from './remote-keep-awake.js';

/**
 * 远程连接期间的休眠抑制（D96 按需连接配套）：连接活着（connecting / online /
 * error）必须阻止系统空闲休眠，否则 WSS 随休眠断开、手机等待中的连接丢失；
 * idle / off 释放。用假 blocker 断言接通 / 释放的幂等与异常兜底。
 */

function fakeBlocker(): PowerSaveBlockerApi & {
  started: number;
  stopped: number[];
  failStart: boolean;
} {
  let nextId = 0;
  return {
    started: 0,
    stopped: [],
    failStart: false,
    start(type) {
      if (this.failStart) throw new Error('not supported on this platform');
      this.started += 1;
      expect(type).toBe('prevent-app-suspension');
      return (nextId += 1);
    },
    stop(id) {
      this.stopped.push(id);
    },
  };
}

describe('remoteConnectionAlive（策略）', () => {
  it('connecting / online / error 算活着；idle / off 与开关关闭不算', () => {
    for (const anchor of ['connecting', 'online', 'error']) {
      expect(remoteConnectionAlive(true, anchor), anchor).toBe(true);
    }
    for (const anchor of ['idle', 'off']) {
      expect(remoteConnectionAlive(true, anchor), anchor).toBe(false);
    }
    for (const anchor of ['connecting', 'online', 'error', 'idle', 'off']) {
      expect(remoteConnectionAlive(false, anchor), `disabled+${anchor}`).toBe(false);
    }
  });
});

describe('createRemoteKeepAwake', () => {
  it('连接活着接通一次（幂等），回到 idle / off 释放', () => {
    const blocker = fakeBlocker();
    const keepAwake = createRemoteKeepAwake(blocker);
    keepAwake.update(true, 'idle');
    expect(blocker.started).toBe(0);

    keepAwake.update(true, 'online');
    expect(blocker.started).toBe(1);
    keepAwake.update(true, 'connecting');
    keepAwake.update(true, 'online');
    expect(blocker.started).toBe(1); // 幂等：状态在活着态之间迁移不重复接通

    keepAwake.update(true, 'idle');
    expect(blocker.stopped).toHaveLength(1);
    keepAwake.update(true, 'idle');
    expect(blocker.stopped).toHaveLength(1); // 幂等：释放态重复调用不再 stop

    keepAwake.update(true, 'error');
    expect(blocker.started).toBe(2); // 重连中也保持唤醒
    keepAwake.update(false, 'online');
    expect(blocker.stopped).toHaveLength(2); // 开关关闭立即释放
  });

  it('start 抛错（平台不支持）不影响后续状态迁移', () => {
    const blocker = fakeBlocker();
    blocker.failStart = true;
    const keepAwake = createRemoteKeepAwake(blocker);
    keepAwake.update(true, 'online');
    keepAwake.update(true, 'idle');
    blocker.failStart = false;
    keepAwake.update(true, 'online');
    expect(blocker.started).toBe(1);
  });
});
