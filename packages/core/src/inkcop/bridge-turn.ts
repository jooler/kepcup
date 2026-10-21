import { randomUUID } from 'node:crypto';
import type { Bot, Message, Run } from '@kepcup/shared';
import type { MessagesService } from '../domain/messages.js';
import type { RunsService } from '../domain/runs.js';
import type { CoreLogger } from '../infra/logger.js';
import type { TriggerBatch } from '../scheduler/mailbox.js';
import {
  InkcopAuthError,
  InkcopHttpError,
  InkcopLocalBridgeClient,
  InkcopOfflineError,
  inkcopAuthTip,
  inkcopOfflineTip,
} from './client.js';
import { inkcopAgentKeyForBot, inkcopExternalId, inkcopMessageId } from './index.js';

/**
 * InkCop 同机桥对话轮（契约 §5 / v0.3）：legacy 整轮 divert（v0.4 起 orchestrator 不再调用）；仅单测保留。
 * mailbox 仍负责串行；本模块只负责一次 run 的 HTTP+SSE 落地与收尾。
 */

export interface InkcopBridgeTurnDeps {
  runs: RunsService;
  messages: MessagesService;
  logger: CoreLogger;
  publish: (event: string, payload: unknown) => void;
  publishConversation: (conversationId: string) => void;
  settleRun: (runId: string, status: Run['status'], error: string | null) => Run;
  releaseTurnMailbox: (runId: string, batch: TriggerBatch, handled: boolean) => void;
  /** 界面语言（settings.general.language）；en → 英文离线提示。 */
  uiLanguage: () => string | null | undefined;
  /** 可注入客户端（单测）；缺省每次 new。 */
  client?: InkcopLocalBridgeClient;
  /** 进行中文案。 */
  inProgressText?: string;
}

function userTextOf(batch: TriggerBatch): string {
  const parts: string[] = [];
  for (const message of batch.messages) {
    if (message.senderType !== 'user' || message.kind !== 'text') continue;
    const text = (message.content as { text?: string }).text ?? '';
    if (text.trim().length > 0) parts.push(text);
  }
  return parts.join('\n\n').trim();
}

export async function executeInkcopBridgeTurn(
  runId: string,
  batch: TriggerBatch,
  bot: Bot,
  deps: InkcopBridgeTurnDeps,
): Promise<void> {
  const client = deps.client ?? new InkcopLocalBridgeClient();
  let handled = false;
  const inProgress = deps.inProgressText ?? '正在调用 InkCop 智能体…';

  const markRunning = (): void => {
    const run = deps.runs.update(runId, { status: 'running' });
    deps.publish('run.status', { run });
  };

  const progress = (text: string): void => {
    deps.publish('run.progress', {
      runId,
      conversationId: batch.conversationId,
      text,
    });
  };

  const appendBot = (text: string): Message => {
    const message = deps.messages.append({
      conversationId: batch.conversationId,
      senderType: 'bot',
      senderBotId: batch.botId,
      kind: 'text',
      text,
      runId,
    });
    const current = deps.runs.get(runId);
    deps.runs.update(runId, {
      outputMessageIds: [...(current?.outputMessageIds ?? []), message.id],
    });
    const full = deps.messages.getById(message.id) ?? message;
    deps.publish('message.created', {
      conversationId: full.conversationId,
      message: full,
    });
    deps.publishConversation(full.conversationId);
    return full;
  };

  const updateBot = (messageId: string, text: string): Message => {
    const updated = deps.messages.updateStreamingText(messageId, text);
    deps.publish('message.updated', {
      conversationId: updated.conversationId,
      message: updated,
    });
    return updated;
  };

  try {
    markRunning();
    progress(inProgress);

    const offlineTip = inkcopOfflineTip(deps.uiLanguage());
    const authTip = inkcopAuthTip(deps.uiLanguage());
    try {
      await client.health();
    } catch (error) {
      if (error instanceof InkcopAuthError) {
        handled = true;
        appendBot(authTip);
        deps.settleRun(runId, 'failed', authTip);
        return;
      }
      if (error instanceof InkcopOfflineError || error instanceof InkcopHttpError) {
        handled = true;
        appendBot(offlineTip);
        deps.settleRun(runId, 'failed', offlineTip);
        return;
      }
      throw error;
    }

    const text = userTextOf(batch);
    if (text.length === 0) {
      handled = true;
      appendBot('（空消息，未发送到 InkCop）');
      deps.settleRun(runId, 'completed', null);
      return;
    }

    const agentKey = inkcopAgentKeyForBot(bot);
    let connectionId: string;
    try {
      const connection = await client.ensureConnection({
        externalId: inkcopExternalId(bot.id, agentKey),
        name: `KepCup · ${bot.name}`,
        agentKey,
      });
      connectionId = connection.connectionId;
    } catch (error) {
      if (error instanceof InkcopAuthError) {
        handled = true;
        appendBot(authTip);
        deps.settleRun(runId, 'failed', authTip);
        return;
      }
      if (error instanceof InkcopOfflineError) {
        handled = true;
        appendBot(offlineTip);
        deps.settleRun(runId, 'failed', offlineTip);
        return;
      }
      handled = true;
      const msg = error instanceof Error ? error.message : String(error);
      appendBot(`连接 InkCop 失败：${msg}`);
      deps.settleRun(runId, 'failed', msg);
      return;
    }

    handled = true;
    let bubbleId: string | null = null;
    let accumulated = '';
    let terminalError: string | null = null;
    let completedText: string | null = null;

    try {
      await client.sendMessage(
        {
          connectionId,
          messageId: inkcopMessageId(randomUUID()),
          text,
          stream: true,
        },
        {
          onAccepted: async () => {
            progress(inProgress);
          },
          onChunk: async (data) => {
            accumulated += data.text;
            if (bubbleId === null) {
              bubbleId = appendBot(accumulated).id;
            } else {
              updateBot(bubbleId, accumulated);
            }
          },
          onComplete: async (data) => {
            completedText = data.text;
            const finalText = data.text.length > 0 ? data.text : accumulated;
            if (bubbleId === null) {
              if (finalText.length > 0) appendBot(finalText);
            } else {
              updateBot(bubbleId, finalText);
            }
          },
          onError: async (data) => {
            terminalError = data.message ?? data.error;
            const failText = terminalError ?? 'InkCop 返回错误';
            if (bubbleId === null) {
              appendBot(failText);
            } else {
              updateBot(bubbleId, accumulated.length > 0 ? `${accumulated}\n\n（失败：${failText}）` : failText);
            }
          },
        },
      );
    } catch (error) {
      if (error instanceof InkcopAuthError) {
        appendBot(authTip);
        deps.settleRun(runId, 'failed', authTip);
        return;
      }
      if (error instanceof InkcopOfflineError) {
        appendBot(offlineTip);
        deps.settleRun(runId, 'failed', offlineTip);
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      if (bubbleId === null) appendBot(`InkCop 通讯失败：${msg}`);
      deps.settleRun(runId, 'failed', msg);
      return;
    }

    if (terminalError !== null) {
      deps.settleRun(runId, 'failed', terminalError);
      return;
    }
    // 无 chunk、仅 complete：上面 onComplete 已落气泡；若 complete 也无字则保持「进行中」结束为空答。
    if (completedText === null && bubbleId === null) {
      appendBot('（InkCop 未返回内容）');
    }
    deps.settleRun(runId, 'completed', null);
  } catch (error) {
    deps.logger.error({ runId, err: error }, 'inkcop bridge turn crashed');
    const msg = error instanceof Error ? error.message : String(error);
    try {
      appendBot(`InkCop 桥接异常：${msg}`);
    } catch {
      // ignore secondary failure
    }
    deps.settleRun(runId, 'failed', msg);
  } finally {
    deps.releaseTurnMailbox(runId, batch, handled);
    deps.publishConversation(batch.conversationId);
  }
}
