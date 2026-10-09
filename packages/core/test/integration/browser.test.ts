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
  viaTask,
  waitFor,
  waitForMessage,
  waitForRun,
  type FakeBrowserHost,
} from '@kepcup/testkit';
import type { Run, RunStep } from '@kepcup/shared';
import { buildRunDigest } from '../../src/agent/context/continuation.js';

/**
 * P11 浏览器工具（集成）：真实任务（D75 W2：浏览器是任务的工具，对话轮没有）
 * 通过端口 B facade 驱动 browser_* 工具；
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
  // D75 W2: the browser is a task's tool (a turn has none) — the turn starts a
  // task that opens the page; the waking turn relays the task's result.
  llm.script(
    'mock-main',
    viaTask({
      instruction: `打开网页 ${url}`,
      taskSteps: [
        step().replyToolCall('browser_open', { url }),
        step()
          .expect((req) => JSON.stringify(req.body).includes('fixture-home-marker'))
          .replyText(finalText),
      ],
      relay: finalText,
    }),
  );
  llm.script('mock-light', [step().replyJson(emptyReflection())]);
  // 群聊必须 @ 具体成员，否则走群聊判断（轻量模型）而不是本脚本的响应 loop。
  await sendDrafts(stack.core, conversationId, [
    {
      text: '打开网页 ' + url,
      ...(options?.mentionBotId !== undefined ? { mentions: [options.mentionBotId] } : {}),
    },
  ]);
  await waitForRun(stack.core, conversationId, 'completed', { loopType: 'task' });
  await waitForMessage(
    stack.core,
    conversationId,
    (m) => m.senderType === 'bot' && 'text' in m.content && m.content.text === finalText,
  );
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
      stack.llm.script(
        'mock-main',
        viaTask({
          taskSteps: [
            step().replyToolCall('browser_open', { url: 'https://fixture.example/second' }),
            step().replyText('第二次打开'),
          ],
        }),
      );
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
      expect(runs.runs.filter((r) => r.loopType === 'turn' || r.loopType === 'task')).toHaveLength(0);
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

      stack.llm.script(
        'mock-main',
        viaTask({
          taskSteps: [
            step().replyToolCall('browser_open', { url: 'http://127.0.0.1:8/step' }),
            step()
              .expect((req) => JSON.stringify(req.body).includes('fixture-home-marker'))
              .replyText('本机页面已打开'),
          ],
          relay: '本机页面已打开',
        }),
      );
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      await sendDrafts(stack.core, conv.id, [{ text: '打开网页 http://127.0.0.1:8/step' }]);
      await waitForRun(stack.core, conv.id, 'completed', { loopType: 'task' });
      // The waking turn must be over too: unbinding is refused while it runs.
      await waitForMessage(
        stack.core,
        conv.id,
        (m) => m.senderType === 'bot' && 'text' in m.content && m.content.text === '本机页面已打开',
      );
      await waitFor(
        () => (stack.core.services.orchestrator!.isMailboxIdle(bot.id, conv.id) ? true : null),
        { label: 'turns idle' },
      );

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

  it('W1 敏感输入：密码框（未标 sensitive）与字符串 "true" 的短值，经引擎落盘后 run_steps / 续接摘要都无明文', async () => {
    const stack = await startStack();
    try {
      // e1 is a password field (host-detected); e2 a plain field typed with a
      // coerced flag and a 3-char value (CVV-like).
      const fakeType = stack.browser.type.bind(stack.browser);
      stack.browser.type = async (input) => {
        await fakeType(input);
        return { ok: true, outcome: 'completed', ...(input.ref === 'e1' ? { passwordField: true } : {}) };
      };
      const bot = await makeBot(stack.core, '阿密');
      const conv = await openDirect(stack.core, bot.id);
      stack.llm.script(
        'mock-main',
        viaTask({
          instruction: '登录',
          writes: false,
          taskSteps: [
            step().replyToolCall('browser_type', { ref: 'e1', text: 'Hunter-77pw' }),
            step().replyToolCall('browser_type', { ref: 'e2', text: '739', sensitive: 'true' }),
            step()
              .expect((req) => JSON.stringify(req.body).includes('不回显'))
              .replyText('已登录'),
          ],
          relay: '已登录',
        }),
      );
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      await sendDrafts(stack.core, conv.id, [{ text: '帮我登录' }]);
      const task = await waitForRun(stack.core, conv.id, 'completed', { loopType: 'task' });
      // The host really received the text (only the records are redacted).
      expect(
        stack.browser.calls.filter((c) => c.method === 'browser.type').map((c) => (c.input as { text: string }).text),
      ).toEqual(['Hunter-77pw', '739']);

      const { steps } = (await stack.core.rpc.call('runs.steps', { runId: task.id })) as { steps: RunStep[] };
      expect(steps.some((s) => s.type === 'request')).toBe(true);
      const all = JSON.stringify(steps);
      expect(all).not.toContain('Hunter-77pw');
      expect(all).not.toMatch(/\\*"text\\*":\s*\\*"739\\*"/);
      expect(all).toContain('«redacted:11 chars»');
      expect(all).toContain('«redacted:3 chars»');

      const digest = buildRunDigest({ run: task, steps, timeZone: 'UTC', budgetTokens: 20_000 });
      expect(digest.length).toBeGreaterThan(0);
      expect(digest).not.toContain('Hunter-77pw');
      expect(digest).not.toMatch(/739/);
    } finally {
      await stack.cleanup();
    }
  });
});


describe('W8 共享浏览器资料 / 自动接管（core 侧）', () => {
  type Core = Stack['core'];

  async function setProfile(core: Core, botId: string, profileId: string): Promise<void> {
    const bot = core.services.domain!.bots.getOrThrow(botId);
    await core.rpc.call('bots.update', {
      id: botId,
      profile: { ...bot.profile, runtime: { ...bot.profile.runtime, browser_profile: profileId } },
    });
  }

  async function createProfile(core: Core, name: string): Promise<string> {
    const result = (await core.rpc.call('browserProfiles.create', { name })) as {
      profile: { id: string };
    };
    return result.profile.id;
  }

  function profileKeysOf(stack: Stack, botId: string): string[] {
    return stack.browser.calls
      .filter((c) => c.method === 'browser.ensurePage' && (c.input as { botId: string }).botId === botId)
      .map((c) => (c.input as { profileKey: string }).profileKey);
  }

  it('profileKey: private bot:{botId} by default; bots on one shared profile both send shared:{id}', async () => {
    const stack = await startStack();
    try {
      const a = await makeBot(stack.core, '共甲');
      const b = await makeBot(stack.core, '共乙');
      const c = await makeBot(stack.core, '私丙');
      const profileId = await createProfile(stack.core, '工作账号');
      expect(profileId).toMatch(/^bpf_/);
      await setProfile(stack.core, a.id, profileId);
      await setProfile(stack.core, b.id, profileId);
      for (const bot of [a, b, c]) {
        const conv = await openDirect(stack.core, bot.id);
        await openWithTool(stack, conv.id, 'https://fixture.example/', `${bot.id} 打开了`);
      }
      expect(new Set(profileKeysOf(stack, a.id))).toEqual(new Set([`shared:${profileId}`]));
      expect(new Set(profileKeysOf(stack, b.id))).toEqual(new Set([`shared:${profileId}`]));
      expect(new Set(profileKeysOf(stack, c.id))).toEqual(new Set([`bot:${c.id}`]));
      const list = (await stack.core.rpc.call('browserProfiles.list')) as {
        profiles: Array<{ id: string; name: string; botIds: string[] }>;
      };
      expect(list.profiles).toEqual([
        expect.objectContaining({ id: profileId, name: '工作账号', botIds: [a.id, b.id] }),
      ]);
      // Only an existing profile can be selected.
      await expect(setProfile(stack.core, c.id, 'bpf_missing')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    } finally {
      await stack.cleanup();
    }
  });

  it('switching profile closes the bot’s pages; clear keeps the entry; delete moves bots back to private and removes the profile; deleting a bot leaves it alone', async () => {
    const stack = await startStack();
    try {
      const a = await makeBot(stack.core, '切甲');
      const b = await makeBot(stack.core, '切乙');
      const conv = await openDirect(stack.core, a.id);
      await openWithTool(stack, conv.id, 'https://fixture.example/', '先私有打开');
      expect(stack.browser.pages.get(`${a.id}|${conv.id}`)?.profileKey).toBe(`bot:${a.id}`);

      const profileId = await createProfile(stack.core, '共享 1');
      await setProfile(stack.core, a.id, profileId);
      // The switch closed every page of the bot; the next call opens it in the new profile.
      expect(stack.browser.closedBotPages).toEqual([a.id]);
      expect(stack.browser.pages.has(`${a.id}|${conv.id}`)).toBe(false);
      await openWithTool(stack, conv.id, 'https://fixture.example/', '共享打开');
      expect(stack.browser.pages.get(`${a.id}|${conv.id}`)?.profileKey).toBe(`shared:${profileId}`);
      // Same profile saved again → no switch.
      await setProfile(stack.core, a.id, profileId);
      expect(stack.browser.closedBotPages).toEqual([a.id]);

      // 清除数据: storage wiped, entry and bots kept.
      await stack.core.rpc.call('browserProfiles.clear', { id: profileId });
      expect(stack.browser.clearedProfiles).toEqual([{ profileId }]);
      expect(stack.core.services.domain!.bots.getOrThrow(a.id).profile.runtime.browser_profile).toBe(
        profileId,
      );

      // Rename.
      await stack.core.rpc.call('browserProfiles.rename', { id: profileId, name: '改名后' });
      expect(stack.core.services.domain!.settings.get().browserProfiles[0]?.name).toBe('改名后');

      // Deleting a bot on the shared profile wipes only its private partition.
      await setProfile(stack.core, b.id, profileId);
      await stack.core.rpc.call('bots.delete', { id: b.id });
      expect(stack.browser.clearedBots).toEqual([b.id]);
      expect(stack.browser.clearedProfiles).toEqual([{ profileId }]);

      // Delete: bots back to private first (pages closed), then the profile is removed.
      const result = (await stack.core.rpc.call('browserProfiles.delete', { id: profileId })) as {
        profiles: unknown[];
        movedBotIds: string[];
      };
      expect(result.movedBotIds).toEqual([a.id]);
      expect(result.profiles).toEqual([]);
      expect(stack.core.services.domain!.bots.getOrThrow(a.id).profile.runtime.browser_profile).toBe('');
      expect(stack.browser.clearedProfiles.at(-1)).toEqual({ profileId, remove: true });
      expect(stack.browser.closedBotPages.at(-1)).toBe(a.id);
      await openWithTool(stack, conv.id, 'https://fixture.example/', '回到私有');
      expect(stack.browser.pages.get(`${a.id}|${conv.id}`)?.profileKey).toBe(`bot:${a.id}`);
    } finally {
      await stack.cleanup();
    }
  });

  it('handback: browser.controlReturned injects "先 browser_snapshot" into the bot’s running browser-using task', async () => {
    const stack = await startStack();
    try {
      const bot = await makeBot(stack.core, '接管');
      const conv = await openDirect(stack.core, bot.id);
      stack.browser.hold('browser.click');
      stack.llm.script(
        'mock-main',
        viaTask({
          instruction: '去点提交',
          taskSteps: [
            step().replyToolCall('browser_open', { url: 'https://fixture.example/' }),
            step().replyToolCall('browser_click', { ref: 'e1' }),
            step().replyText('点完了'),
          ],
          relay: '点完了',
        }),
      );
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      await sendDrafts(stack.core, conv.id, [{ text: '去点提交' }]);
      const runs = stack.core.services.domain!.runs;
      const task = await waitFor(
        () =>
          stack.browser.calls.some((c) => c.method === 'browser.click')
            ? (runs.listTasks({ conversationId: conv.id }).at(-1) ?? null)
            : null,
        { label: 'task mid-click', timeoutMs: 20_000 },
      );
      const handle = stack.core.services.platformMethods['browser.controlReturned']!.handle;
      // Another conversation / bot: nothing to notify.
      expect(
        await handle({ botId: bot.id, conversationId: 'conv_other', reason: 'button' }),
      ).toEqual({ injected: 0 });
      expect(
        await handle({ botId: bot.id, conversationId: conv.id, reason: 'viewer_closed' }),
      ).toEqual({ injected: 1 });
      // Taking over and handing back again right away: one notice (coalesced).
      expect(
        await handle({ botId: bot.id, conversationId: conv.id, reason: 'button' }),
      ).toEqual({ injected: 0 });
      const injects = stack.core.services
        .domain!.messages.taskEvents(task.id)
        .map((m) => m.content as { phase: string; text: string })
        .filter((c) => c.phase === 'inject');
      expect(injects.map((c) => c.text)).toEqual(['用户已交还浏览器控制，先 browser_snapshot 再继续']);
      stack.browser.release('browser.click');
      await waitForRun(stack.core, conv.id, 'completed', { loopType: 'task' });
      // The steer reached the task's model.
      const seen = stack.llm
        .requests()
        .some((req) => JSON.stringify(req.body).includes('用户已交还浏览器控制，先 browser_snapshot 再继续'));
      expect(seen).toBe(true);
    } finally {
      await stack.cleanup();
    }
  });
});
