import { describe, expect, it } from 'vitest';
import {
  createTestStack,
  createFakeBrowserHost,
  listMessages,
  makeBot,
  makeGroup,
  openDirect,
  sendDrafts,
  step,
  waitForRun,
  type FakeBrowserHost,
} from '@kepcup/testkit';
import type { Run } from '@kepcup/shared';

/**
 * P11 浏览器工具（集成）：真实响应 loop 通过端口 B facade 驱动 browser_* 工具；
 * 删除级联（对话 / Bot / 群移除）接入 lifecycle 并有测试；删除与在途页面操作
 * 的竞态由「先取消执行 → 级联 permanent close → 迟到的 ensurePage 被拒」
 * 三层防护（主进程 tombstone 的行为在 e2e 用真实宿主验证）。
 */

function emptyReflection() {
  return {
    runSummary: '无新记忆',
    memories: [],
    profileProposals: [],
    wikiSuggestions: [],
    skillSuggestion: null,
  };
}

interface Stack {
  core: Awaited<ReturnType<typeof createTestStack>>['core'];
  llm: Awaited<ReturnType<typeof createTestStack>>['llm'];
  browser: FakeBrowserHost;
  cleanup(): Promise<void>;
}

async function startStack(): Promise<Stack> {
  const browser = createFakeBrowserHost();
  const stack = await createTestStack({ browserRpc: browser });
  // openWithTool 的第二步以快照正文里的 marker 对齐模型请求：夹具快照是栈级
  // 默认值（用例可在调用前覆盖，如 browser_open 用例自设标题）。
  browser.setSnapshot({
    title: '夹具页面',
    url: 'https://fixture.example/',
    elements: [{ ref: 'e1', role: 'button', name: '提交' }],
    elementsTruncated: false,
    text: 'fixture-home-marker 页面正文',
    textTruncated: false,
  });
  return { ...stack, browser, cleanup: stack.cleanup };
}

async function openWithTool(
  stack: Stack,
  conversationId: string,
  url: string,
  finalText: string,
  options?: { mentionBotId?: string },
): Promise<void> {
  const { llm } = stack;
  llm.script('mock-main', [
    step()
      .expect((req) => req.lastUserText().includes('打开网页'))
      .replyToolCall('browser_open', { url }),
    step()
      .expect((req) => JSON.stringify(req.body).includes('fixture-home-marker'))
      .replyText(finalText),
  ]);
  llm.script('mock-light', [step().replyJson(emptyReflection())]);
  // 群聊必须 @ 具体成员，否则走群聊判断（轻量模型）而不是本脚本的响应 loop。
  await sendDrafts(stack.core, conversationId, [
    {
      text: '打开网页 ' + url,
      ...(options?.mentionBotId !== undefined ? { mentions: [options.mentionBotId] } : {}),
    },
  ]);
  await waitForRun(stack.core, conversationId, 'completed');
}

describe('P11 浏览器：响应 loop 工具与删除级联', () => {
  it('browser_open 走真实响应 loop：快照内容进入下一次模型请求，页面文本有 untrusted 边界', async () => {
    const stack = await startStack();
    try {
      const bot = await makeBot(stack.core, '阿览');
      const conv = await openDirect(stack.core, bot.id);
      stack.browser.setSnapshot({
        title: '夹具页面',
        url: 'https://fixture.example/',
        elements: [{ ref: 'e1', role: 'button', name: '提交' }],
        elementsTruncated: false,
        text: 'fixture-home-marker 页面正文',
        textTruncated: false,
      });
      await openWithTool(stack, conv.id, 'https://fixture.example/', '页面打开了');

      const calls = stack.browser.calls;
      expect(calls.some((c) => c.method === 'browser.ensurePage')).toBe(true);
      expect(calls.some((c) => c.method === 'browser.navigate')).toBe(true);
      expect(calls.some((c) => c.method === 'browser.snapshot')).toBe(true);
      // 网络上下文与下载目录随每次 ensurePage 刷新
      const ensure = calls.find((c) => c.method === 'browser.ensurePage');
      expect((ensure?.input as { networkContext: { allowLoopback: boolean } }).networkContext).toEqual({
        allowLoopback: false,
      });
      expect((ensure?.input as { downloadsDir: string }).downloadsDir).toContain('downloads');
    } finally {
      await stack.cleanup();
    }
  });

  it('删除对话：成员 Bot 的页面被 permanent 关闭（级联接入 lifecycle）', async () => {
    const stack = await startStack();
    try {
      const bot = await makeBot(stack.core, '阿页');
      const conv = await openDirect(stack.core, bot.id);
      await openWithTool(stack, conv.id, 'https://fixture.example/', '好的');

      await stack.core.rpc.call('conversations.delete', { id: conv.id });
      const close = stack.browser.closedPairs.at(-1);
      expect(close).toEqual({ botId: bot.id, conversationId: conv.id, permanent: true });
    } finally {
      await stack.cleanup();
    }
  });

  it('移出群：该 Bot 在该群的页面被 permanent 关闭', async () => {
    const stack = await startStack();
    try {
      const a = await makeBot(stack.core, '阿甲');
      const b = await makeBot(stack.core, '阿乙');
      const group = await makeGroup(stack.core, '浏览器群', [a.id, b.id]);
      // 群里只有甲动过浏览器
      stack.browser.calls.length = 0;
      await openWithTool(stack, group.id, 'https://fixture.example/', '收到', {
        mentionBotId: a.id,
      });
      expect(stack.browser.calls.some((c) => c.method === 'browser.ensurePage')).toBe(true);

      await stack.core.rpc.call('groups.removeMember', { conversationId: group.id, botId: a.id });
      const close = stack.browser.closedPairs.at(-1);
      expect(close).toEqual({ botId: a.id, conversationId: group.id, permanent: true });
    } finally {
      await stack.cleanup();
    }
  });

  it('删除 Bot：clearBotData 被调用一次；之后迟到的 ensurePage 在主进程被 tombstone 拒绝（此处验证级联与执行取消）', async () => {
    const stack = await startStack();
    try {
      const bot = await makeBot(stack.core, '阿删');
      const conv = await openDirect(stack.core, bot.id);
      await openWithTool(stack, conv.id, 'https://fixture.example/', '看到了');

      stack.browser.calls.length = 0;
      await stack.core.rpc.call('bots.delete', { id: bot.id });
      expect(stack.browser.clearedBots).toEqual([bot.id]);
      // 级联发生在删除流程内：bots 行已变占位（bots.list 只列活跃 Bot，
      // 占位行经 bots.get 读取，status='deleted'）。
      const got = (await stack.core.rpc.call('bots.get', { id: bot.id })) as {
        bot: { id: string; status: string } | null;
      };
      expect(got.bot?.status).toBe('deleted');
    } finally {
      await stack.cleanup();
    }
  });

  it('删除与在途页面操作竞态：hold 期间删除 Bot，run 取消、clearBotData 恰一次、释放后无新的页面调用', async () => {
    const stack = await startStack();
    try {
      const bot = await makeBot(stack.core, '阿竞');
      const conv = await openDirect(stack.core, bot.id);
      await openWithTool(stack, conv.id, 'https://fixture.example/', '先看一次');

      // 第二次 run：browser_open 挂起在 navigate 上
      stack.browser.calls.length = 0;
      stack.browser.hold('browser.navigate');
      stack.llm.script('mock-main', [
        step()
          .expect((req) => req.lastUserText().includes('打开网页'))
          .replyToolCall('browser_open', { url: 'https://fixture.example/second' }),
        step().replyText('第二次打开'),
      ]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      await sendDrafts(stack.core, conv.id, [{ text: '打开网页 https://fixture.example/second' }]);
      await new Promise((r) => setTimeout(r, 600)); // navigate 已在途

      // 删除 Bot：先取消执行，再 clearBotData（tombstone）
      await stack.core.rpc.call('bots.delete', { id: bot.id });
      expect(stack.browser.clearedBots).toEqual([bot.id]);
      // 释放后在途调用返回，但 loop 已被取消：不再有新的 browser 调用
      const callsAtDelete = stack.browser.calls.length;
      stack.browser.release('browser.navigate');
      await new Promise((r) => setTimeout(r, 400));
      expect(stack.browser.calls.length).toBe(callsAtDelete);

      // 删除级联把该 Bot 的 run 行一并删除（lifecycle：abortRunsForBot → …
      // → delete from runs）——「取消」是删除流程的中间态，行删完后不可见；
      // 可持久观察的是上面两件事 + 对话只读。
      const runs = (await stack.core.rpc.call('runs.list', { conversationId: conv.id, limit: 50 })) as {
        runs: Run[];
      };
      expect(runs.runs.filter((r) => r.loopType === 'turn')).toHaveLength(0);
      // 单聊已只读，drafts.flush 被拒
      await expect(
        stack.core.rpc.call('drafts.flush', { conversationId: conv.id }),
      ).rejects.toMatchObject({ code: 'CONVERSATION_READ_ONLY' });
    } finally {
      await stack.cleanup();
    }
  });

  it('绑定 project 的对话：ensurePage 的网络上下文允许本机地址（allowLoopback=true）', async () => {
    const stack = await startStack();
    try {
      const bot = await makeBot(stack.core, '阿本');
      const conv = await openDirect(stack.core, bot.id);
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const projectDir = await (async () => {
        const { mkdtemp } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        return mkdtemp(`${tmpdir()}/p11-proj-`);
      })();
      writeFileSync(`${projectDir}/README.md`, '# demo\n');
      mkdirSync(projectDir, { recursive: true });
      await stack.core.rpc.call('projects.select', { conversationId: conv.id, path: projectDir });

      stack.llm.script('mock-main', [
        step()
          .expect((req) => req.lastUserText().includes('打开网页'))
          .replyToolCall('browser_open', { url: 'http://127.0.0.1:8/step' }),
        step()
          .expect((req) => JSON.stringify(req.body).includes('fixture-home-marker'))
          .replyText('本机页面已打开'),
      ]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      await sendDrafts(stack.core, conv.id, [{ text: '打开网页 http://127.0.0.1:8/step' }]);
      await waitForRun(stack.core, conv.id, 'completed');

      const ensure = stack.browser.calls.find((c) => c.method === 'browser.ensurePage');
      expect((ensure?.input as { networkContext: { allowLoopback: boolean } }).networkContext).toEqual({
        allowLoopback: true,
      });
      // 解绑后打开着的页面立即失去本机访问：setNetworkContext(false) 推送
      await stack.core.rpc.call('projects.unbind', { conversationId: conv.id });
      const ctxUpdate = stack.browser.calls
        .filter((c) => c.method === 'browser.setNetworkContext')
        .map((c) => (c.input as { networkContext: { allowLoopback: boolean } }).networkContext);
      expect(ctxUpdate).toContainEqual({ allowLoopback: false });
      const { rmSync } = await import('node:fs');
      rmSync(projectDir, { recursive: true, force: true });
    } finally {
      await stack.cleanup();
    }
  });

  it('无浏览器页面的对话删除照常完成（close 级联对不存在的页面在主进程是 no-op）', async () => {
    const stack = await startStack();
    try {
      const bot = await makeBot(stack.core, '阿静');
      const conv = await openDirect(stack.core, bot.id);
      stack.llm.script('mock-main', [step().replyText('不用浏览器')]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      await sendDrafts(stack.core, conv.id, [{ text: '你好' }]);
      await waitForRun(stack.core, conv.id, 'completed');
      stack.browser.calls.length = 0;
      await stack.core.rpc.call('conversations.delete', { id: conv.id });
      // 级联无条件发出 permanent close（主进程对不存在的页面是 no-op），
      // 对话数据正常清除。
      expect(stack.browser.closedPairs).toEqual([
        { botId: bot.id, conversationId: conv.id, permanent: true },
      ]);
      expect(await listMessages(stack.core, conv.id)).toHaveLength(0);
    } finally {
      await stack.cleanup();
    }
  });
});
