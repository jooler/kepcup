import { IM_FORWARD_MAX_CHARS, IM_FORWARD_TRUNCATED_SUFFIX, type Message } from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { ImService } from './service.js';

/**
 * 出站转发器（D110，54 号文档 §6）：订阅 EventBus `message.created`（**core 内订阅**
 * ——窗口关闭、后台、headless（D102）都必须转发），把 Bot 私聊里的最终文本回复交给
 * ImService 排队。转发是通道镜像不是工具调用：不走网关审批（用户开启同步即持续授权），
 * Bot 与提示词全程无感（无 im_send 工具）。
 *
 * 触发过滤：`role=assistant` 的最终回复（senderType 'bot' 的 text 消息；流式中间态 /
 * internal 系统消息 / 卡片 / 任务事件天然不在信号里），且会话为「用户 ↔ 该 Bot」的私聊。
 * 不转发审批卡正文（审批必须在应用内完成）；内容规则 = Markdown 剥格式 + 截断（§6）。
 */

export interface ImForwarderDeps {
  im: ImService;
  conversations: ConversationsService;
  logger: CoreLogger;
}

export class ImForwarder {
  readonly #deps: ImForwarderDeps;

  constructor(deps: ImForwarderDeps) {
    this.#deps = deps;
  }

  /** message.created 信号入口（start.ts 订阅事件总线后转发到这里）。 */
  handleMessage(message: Message): void {
    try {
      this.#handle(message);
    } catch (error) {
      // 转发排队失败不影响对话主链路。
      this.#deps.logger.warn(
        { messageId: message.id, error: error instanceof Error ? error.message : String(error) },
        'im forwarder enqueue failed',
      );
    }
  }

  #handle(message: Message): void {
    if (message.senderType !== 'bot' || message.senderBotId === null) return;
    if (message.kind !== 'text' || message.status !== 'normal') return;
    const text = (message.content as { text?: string } | undefined)?.text ?? '';
    if (text.trim() === '') return;
    const conversation = this.#deps.conversations.get(message.conversationId);
    if (conversation === null) return;
    // 只镜像「用户 ↔ 该 Bot」的私聊；项目组 / 卡片会话不是通道语义（54 §6）。
    if (conversation.type !== 'direct' || conversation.directBotId !== message.senderBotId) return;
    this.#deps.im.enqueueForwards({
      conversationId: message.conversationId,
      messageId: message.id,
      botId: message.senderBotId,
      text: renderForwardText(text),
    });
  }
}

/**
 * Markdown → 纯文本（54 §6：首期剥格式，不渲染）。剥代码围栏栅栏、标题井号、
 * 强调记号与链接语法；列表 / 引用保留行首记号保证结构可读。超长截断并加尾注。
 */
export function renderForwardText(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    let line = raw;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      // 围栏行本身不输出（首期不保留代码块边界记号）。
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    line = line.replace(/^(\s*)#{1,6}\s+/, '$1');
    line = line.replace(/`([^`]*)`/g, '$1');
    line = line.replace(/!\[([^\]]*)\]\([^)]*\)/g, '[$1]');
    line = line.replace(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '$1（$2）');
    line = line.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
    line = line.replace(/(^|\W)\*([^*\s][^*]*)\*/g, '$1$2').replace(/(^|\W)_([^_\s][^_]*)_/g, '$1$2');
    line = line.replace(/^\s*>\s?/, '» ');
    out.push(line);
  }
  const text = out.join('\n').trim();
  if (text.length <= IM_FORWARD_MAX_CHARS) return text;
  return text.slice(0, IM_FORWARD_MAX_CHARS) + IM_FORWARD_TRUNCATED_SUFFIX;
}
