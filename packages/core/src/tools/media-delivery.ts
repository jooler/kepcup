import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Message } from '@kepcup/shared';
import type { RunIdentity, ToolResult } from '../agent/types.js';
import { MAX_ATTACHMENT_BYTES, type AttachmentsService } from '../domain/attachments.js';
import type { MessagesService } from '../domain/messages.js';
import type { ToolGateway } from '../gateway/index.js';

/**
 * 生成类媒体工具（generate_image / generate_speech / generate_video）的**确定性
 * 投递**：产物落盘后由工具本身把文件作为 Bot 消息附件发进对话（任务内即进度
 * 消息，归属当前任务），不再依赖模型记得调 send_message 的 attachment_paths
 * ——漏发会让「已生成」的报告没有图可看。caption 为空串时只发附件。
 *
 * 投递可能部分或全部失败（文件过大 / 路径无权限 / 读不了 / 没有对话上下文），
 * `send` 因此返回逐文件的结果，工具据此决定告诉模型「已显示」还是「文件在
 * workspace，请用 send_message 的 attachment_paths 补发」——绝不能在没投递成功
 * 时谎称「已显示」，否则用户既看不到文件、模型也拿不到路径无从补救。
 */
export interface GeneratedMediaDelivery {
  send(files: string[], caption: string): MediaDeliveryOutcome;
}

export interface MediaDeliveryFailure {
  path: string;
  /** 面向模型的中文失败原因（过大 / 无权限 / 读取失败 …）。 */
  reason: string;
}

export interface MediaDeliveryOutcome {
  /** 已作为消息附件发出的文件（原始 workspace 路径）。 */
  delivered: string[];
  failed: MediaDeliveryFailure[];
}

export interface GeneratedMediaDeliveryDeps {
  identity: RunIdentity;
  gateway: ToolGateway;
  attachments: AttachmentsService;
  messages: Pick<MessagesService, 'append'>;
  onBotMessage: (message: Message) => void;
  /** 事件发布失败只记日志（消息已落库，不能回头算「没投递成功」）。 */
  logger?: { warn(fields: Record<string, unknown>, msg: string): void } | undefined;
  guessMime: (fileName: string) => string;
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

export function createGeneratedMediaDelivery(
  deps: GeneratedMediaDeliveryDeps,
): GeneratedMediaDelivery {
  const { identity } = deps;
  return {
    send: (files, caption) => {
      if (identity.conversationId === null || identity.botId === null) {
        return {
          delivered: [],
          failed: files.map((file) => ({ path: file, reason: '当前执行没有对话上下文' })),
        };
      }
      const conversationId = identity.conversationId;
      const botId = identity.botId;
      const failed: MediaDeliveryFailure[] = [];
      const uploaded: Array<{ id: string; source: string }> = [];
      for (const filePath of files) {
        const decision = deps.gateway.checkPath(identity, filePath, 'read');
        if (decision.kind !== 'allowed') {
          failed.push({
            path: filePath,
            reason: `没有读取权限（${decision.reason}）`,
          });
          continue;
        }
        let bytes: Buffer;
        try {
          bytes = readFileSync(decision.resolvedPath);
        } catch (error) {
          failed.push({
            path: filePath,
            reason: `读取文件失败（${error instanceof Error ? error.message : String(error)}）`,
          });
          continue;
        }
        if (bytes.length > MAX_ATTACHMENT_BYTES) {
          failed.push({
            path: filePath,
            reason: `文件过大（${megabytes(bytes.length)}MB，附件上限 ${megabytes(MAX_ATTACHMENT_BYTES)}MB）`,
          });
          continue;
        }
        try {
          const attachment = deps.attachments.upload({
            conversationId,
            fileName: path.basename(filePath),
            mime: deps.guessMime(filePath),
            bytes,
          });
          uploaded.push({ id: attachment.id, source: filePath });
        } catch (error) {
          failed.push({
            path: filePath,
            reason: `上传附件失败（${error instanceof Error ? error.message : String(error)}）`,
          });
        }
      }
      if (uploaded.length === 0) return { delivered: [], failed };
      // 消息 + 附件绑定在 append 的同一事务里完成：要么都落库，要么都不落库——
      // 不会留下「已发出但没有附件的空 caption 消息」。事件发布放在 try 之外：消息
      // 一旦落库就是已投递，发布失败（订阅者抛错等）只记日志，否则会被误判为
      // 「没投递成功」让模型 send_message 补发造成重复。
      let message: Message;
      try {
        message = deps.messages.append({
          conversationId,
          senderType: 'bot',
          senderBotId: botId,
          kind: 'text',
          text: caption,
          replyTo: null,
          mentions: [],
          runId: identity.runId,
          attachmentIds: uploaded.map((a) => a.id),
          // D75 §6.1: a task's messages are progress, attributed to the task.
          ...(identity.loopType !== 'turn' ? { taskOrigin: { taskId: identity.runId } } : {}),
        });
      } catch (error) {
        // 事务已回滚：消息没发出去，附件仍是未绑定的上传，回收掉以免成为孤儿。
        for (const { id } of uploaded) {
          try {
            deps.attachments.detach(id);
          } catch {
            // 回收尽力而为（行已不在 / 已被绑定则保留）。
          }
        }
        const reason = `消息发送失败（${error instanceof Error ? error.message : String(error)}）`;
        return {
          delivered: [],
          failed: [...failed, ...uploaded.map((a) => ({ path: a.source, reason }))],
        };
      }
      try {
        deps.onBotMessage(message);
      } catch (error) {
        deps.logger?.warn(
          { err: error instanceof Error ? error.message : String(error), messageId: message.id },
          'generated media message was stored but publishing its event failed',
        );
      }
      return { delivered: uploaded.map((a) => a.source), failed };
    },
  };
}

/**
 * 生成工具的投递后结果文案：全部成功 → 告诉模型「已显示」（不回路径，避免被复述）；
 * 否则 → 把未投递文件的路径与原因交还模型，让它用 send_message 补发或向用户说明。
 *
 * @param generated 已生成的产物名词短语，如「3 张图片」「语音」
 */
export function mediaDeliveryResult(input: {
  generated: string;
  saved: string[];
  outcome: MediaDeliveryOutcome;
  /** 全部成功时的收尾句（缺省为通用提示）。 */
  successHint?: string;
}): ToolResult {
  const { generated, saved, outcome } = input;
  if (outcome.failed.length === 0 && outcome.delivered.length === saved.length) {
    return {
      ok: true,
      content: `已生成${generated}，并已作为消息附件显示在用户的对话界面中。无需再调 send_message，也不要向用户复述文件路径；${input.successHint ?? '只需用一句话向用户确认即可。'}`,
    };
  }
  const undelivered = saved.filter((file) => !outcome.delivered.includes(file));
  const reasons = outcome.failed.length
    ? outcome.failed.map((f) => `- ${f.path}：${f.reason}`).join('\n')
    : undelivered.map((file) => `- ${file}：未能发送`).join('\n');
  const list = undelivered.join('\n');
  const head =
    outcome.delivered.length > 0
      ? `已生成${generated}，其中 ${outcome.delivered.length} 个文件已作为消息附件显示在用户的对话界面中，但另有 ${undelivered.length} 个文件投递失败：`
      : `已生成${generated}并保存到 workspace，但自动投递到对话失败，用户目前看不到文件：`;
  return {
    ok: true,
    content: `${head}\n${reasons}\n未送达的文件路径：\n${list}\n可修复的（如读取权限）处理后请用 send_message 的 attachment_paths 把这些文件发给用户；无法作为附件发送的（如超过大小上限）请向用户如实说明文件在 workspace 的位置，不要声称已显示。`,
  };
}
