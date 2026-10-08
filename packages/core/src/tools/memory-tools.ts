import { Type } from '@earendil-works/pi-ai';
import { AppError, type MemoryKind, type Message, type ProfileCategory } from '@kepcup/shared';
import type { RunIdentity, ToolDefinition } from '../agent/types.js';
import type { RetrievedMemories } from '../memory/retrieve.js';
import type { RememberResult } from '../memory/service.js';
import type { MemoryItem, ProfileItem } from '@kepcup/shared';

/**
 * The seven memory tools (docs/dev/phases/P07-memory.md 任务 4). All writes
 * go through MemoryService, where the code-enforced validation runs; the
 * model's cooperation is never required for correctness.
 */

/** The slice of MemoryService (plus approvals) the tools need. */
export interface MemoryToolFacade {
  writeMemory(
    botId: string,
    conversationId: string | null,
    input: {
      content: string;
      kind: MemoryKind;
      privateToBot?: boolean;
      dueAt?: string;
      validUntil?: string;
      triggerMessages: Message[];
    },
  ): Promise<RememberResult>;
  recall(
    botId: string,
    conversationId: string,
    query: string,
    kind?: MemoryKind,
  ): Promise<RetrievedMemories>;
  getUserProfile(category?: ProfileCategory): ProfileItem[];
  listCommitments(botId: string): MemoryItem[];
  feedback(botId: string, itemId: string, reason: 'outdated' | 'wrong'): { ok: boolean; message: string };
  forget(botId: string, itemIds: string[]): { retracted: string[]; proposed: string[] };
  /** Blocking `profile_change` approval; applies changes when approved. */
  requestProfileChange(
    identity: RunIdentity,
    changes: Array<{ field: string; value: string }>,
    reason: string,
    signal: AbortSignal,
  ): Promise<{ approved: boolean; note: string }>;
  /**
   * Non-blocking `profile_change` for supervisor turns (D75 审查 M4): submits
   * the card and returns; the decision reaches the bot later as an event.
   * Absent = a turn cannot propose (it never waits for the user).
   */
  submitProfileChange?(
    identity: RunIdentity,
    changes: Array<{ field: string; value: string }>,
    reason: string,
  ): void;
  /** Trigger messages of the current run (evidence for explicit writes). */
  triggerMessages(): Message[];
}

const KINDS = ['fact', 'preference', 'commitment', 'feedback', 'episode', 'lesson', 'self_note'] as const;
const CATEGORIES = ['basic', 'communication', 'work', 'interests', 'boundaries', 'recent'] as const;

/** Whitelisted profile fields a bot may propose to change (design/03-bot.md). */
export const PROFILE_CHANGE_FIELDS = [
  'identity.bio',
  'persona.personality',
  'persona.tone',
  'persona.style',
  'persona.values',
  'persona.sample_dialogues',
  'role.expertise',
  'role.responsibilities',
] as const;

export function buildMemoryTools(input: {
  identity: RunIdentity;
  memory: MemoryToolFacade;
}): ToolDefinition[] {
  const { identity, memory } = input;
  const requireConversation = (): { botId: string; conversationId: string } | null => {
    if (identity.conversationId === null || identity.botId === null) return null;
    return { botId: identity.botId, conversationId: identity.conversationId };
  };
  const noConversation = (): { ok: false; content: string; errorCode: string } => ({
    ok: false,
    content: '当前执行没有对话上下文，无法使用记忆工具',
    errorCode: 'INVALID_INPUT',
  });

  const remember: ToolDefinition<{
    content: string;
    kind: (typeof KINDS)[number];
    private_to_bot?: boolean;
    due_at?: string;
  }> = {
    name: 'remember',
    description:
      '用户明确要求记住时使用；立即写入你的长期记忆（证据为本次触发消息）。kind=commitment（承诺）可给 due_at（ISO 8601，如 2026-10-08）。关于用户本人的事实会同时生成画像提案，由系统的画像整理任务统一处理。敏感类别（健康、财务、感情、他人隐私）即使用户要求记住，也只会留在你的私有记忆，不会进入共享画像。',
    parameters: Type.Object({
      content: Type.String({ description: '要记住的一句自然语言陈述' }),
      kind: Type.Union(
        KINDS.map((k) => Type.Literal(k)),
        { description: '记忆类型' },
      ),
      private_to_bot: Type.Optional(
        Type.Boolean({
          description:
            '用户说“只告诉你”时为 true，不进入共享画像；涉及健康、财务、感情等敏感内容时也应为 true',
        }),
      ),
      due_at: Type.Optional(Type.String({ description: '承诺截止时间（ISO 8601）' })),
    }),
    execute: async (params) => {
      const ctx = requireConversation();
      if (ctx === null) return noConversation();
      const result = await memory.writeMemory(ctx.botId, ctx.conversationId, {
        content: params.content,
        kind: params.kind,
        ...(params.private_to_bot !== undefined ? { privateToBot: params.private_to_bot } : {}),
        ...(params.due_at !== undefined ? { dueAt: params.due_at } : {}),
        triggerMessages: memory.triggerMessages(),
      });
      if (!result.ok) {
        return {
          ok: false,
          content: `没有记住这条内容：${result.reason}`,
          errorCode: 'MEMORY_REJECTED',
        };
      }
      const suffix =
        params.kind === 'fact' || params.kind === 'preference'
          ? '；已同时生成画像提案，等待画像整理任务处理'
          : '';
      return { ok: true, content: `已记住（id：${result.item?.id ?? '未知'}）${suffix}` };
    },
  };

  const recallMemory: ToolDefinition<{ query: string; kind?: (typeof KINDS)[number] }> = {
    name: 'recall_memory',
    description: '检索你的长期记忆，返回最相关的条目（含 id，可用于 memory_feedback / forget）。',
    parameters: Type.Object({
      query: Type.String({ description: '检索关键词或问题' }),
      kind: Type.Optional(
        Type.Union(
          KINDS.map((k) => Type.Literal(k)),
          { description: '只返回某一类型' },
        ),
      ),
    }),
    execute: async (params) => {
      const ctx = requireConversation();
      if (ctx === null) return noConversation();
      const result = await memory.recall(
        ctx.botId,
        ctx.conversationId,
        params.query,
        params.kind,
      );
      if (result.items.length === 0) return { ok: true, content: '没有找到相关记忆。' };
      const lines = result.items.map((item) => `- [${item.id}] (${item.kind}) ${item.content}`);
      return { ok: true, content: `<untrusted>\n${lines.join('\n')}\n</untrusted>` };
    },
  };

  const getUserProfile: ToolDefinition<{ category?: (typeof CATEGORIES)[number] }> = {
    name: 'get_user_profile',
    description: '查询共享用户画像的完整条目（所有 Bot 共享；平时注入的是摘要卡片）。',
    parameters: Type.Object({
      category: Type.Optional(
        Type.Union(
          CATEGORIES.map((c) => Type.Literal(c)),
          { description: '只看某一分类' },
        ),
      ),
    }),
    execute: async (params) => {
      const items = memory.getUserProfile(params.category);
      if (items.length === 0) return { ok: true, content: '画像中还没有该分类的条目。' };
      const lines = items.map((item) => `- [${item.id}] (${item.category}) ${item.content}`);
      return { ok: true, content: `<untrusted>\n${lines.join('\n')}\n</untrusted>` };
    },
  };

  const listCommitments: ToolDefinition<Record<string, never>> = {
    name: 'list_commitments',
    description: '列出你的有效承诺（按截止时间排序）。',
    parameters: Type.Object({}),
    execute: async () => {
      const ctx = requireConversation();
      if (ctx === null) return noConversation();
      const items = memory.listCommitments(ctx.botId);
      if (items.length === 0) return { ok: true, content: '当前没有未完成的承诺。' };
      const lines = items.map((item) => {
        const due = item.dueAt !== null ? new Date(item.dueAt).toISOString().slice(0, 10) : '未定期';
        return `- [${item.id}] ${due}：${item.content}`;
      });
      return { ok: true, content: `<untrusted>\n${lines.join('\n')}\n</untrusted>` };
    },
  };

  const memoryFeedback: ToolDefinition<{ item_id: string; reason: 'outdated' | 'wrong'; note?: string }> = {
    name: 'memory_feedback',
    description:
      '发现注入的记忆有误或过时时调用。wrong（错误）会撤回该条；outdated（过时）会标记为已过时；画像条目会生成撤回提案，由画像整理任务处理。',
    parameters: Type.Object({
      item_id: Type.String({ description: '记忆或画像条目 id' }),
      reason: Type.Union([Type.Literal('outdated'), Type.Literal('wrong')], {
        description: 'outdated=过时；wrong=错误',
      }),
      note: Type.Optional(Type.String({ description: '补充说明（可选）' })),
    }),
    execute: async (params) => {
      const ctx = requireConversation();
      if (ctx === null) return noConversation();
      const result = memory.feedback(ctx.botId, params.item_id, params.reason);
      return { ok: result.ok, content: result.message, ...(result.ok ? {} : { errorCode: 'NOT_FOUND' }) };
    },
  };

  const forget: ToolDefinition<{ item_ids: string[] }> = {
    name: 'forget',
    description:
      '用户要求忘掉某些内容时使用。你的记忆立即撤回；画像条目会立即触发画像整理（生成撤回提案并处理）。',
    parameters: Type.Object({
      item_ids: Type.Array(Type.String(), { description: '要忘掉的条目 id（mem_… / prf_…）' }),
    }),
    execute: async (params) => {
      const ctx = requireConversation();
      if (ctx === null) return noConversation();
      const result = memory.forget(ctx.botId, params.item_ids);
      const parts: string[] = [];
      if (result.retracted.length > 0) parts.push(`已撤回 ${result.retracted.join('、')}`);
      if (result.proposed.length > 0) parts.push(`画像撤回提案已提交并触发整理：${result.proposed.join('、')}`);
      if (parts.length === 0) return { ok: true, content: '没有找到对应的条目。' };
      return { ok: true, content: `${parts.join('；')}。` };
    },
  };

  const proposeProfileChange: ToolDefinition<{
    changes: Array<{ field: string; value: string }>;
    reason: string;
  }> = {
    name: 'propose_profile_change',
    description:
      identity.loopType === 'turn'
        ? '向用户提出修改你自己 Profile 的建议（性格、语气、职责等），用户批准后写入。field 只能是：identity.bio、persona.personality、persona.tone、persona.style、persona.values、persona.sample_dialogues、role.expertise、role.responsibilities。提交后立即返回，不等待用户决定；用户决定后宿主会通知你结果。'
        : '向用户提出修改你自己 Profile 的建议（性格、语气、职责等），用户批准后写入。field 只能是：identity.bio、persona.personality、persona.tone、persona.style、persona.values、persona.sample_dialogues、role.expertise、role.responsibilities。执行会等待用户决定。',
    parameters: Type.Object({
      changes: Type.Array(
        Type.Object({ field: Type.String(), value: Type.String() }),
        { description: '要修改的字段与新值' },
      ),
      reason: Type.String({ description: '建议原因，会展示给用户' }),
    }),
    execute: async (params, toolCtx) => {
      const ctx = requireConversation();
      if (ctx === null) return noConversation();
      const invalid = params.changes.filter(
        (change) => !(PROFILE_CHANGE_FIELDS as readonly string[]).includes(change.field),
      );
      if (invalid.length > 0 || params.changes.length === 0) {
        return {
          ok: false,
          content: `field 只能是：${PROFILE_CHANGE_FIELDS.join('、')}`,
          errorCode: 'INVALID_INPUT',
        };
      }
      // D75 审查 M4: a turn never parks on the user's decision — that would
      // hold the (bot, conversation) mailbox. Submit and move on.
      if (identity.loopType === 'turn') {
        if (memory.submitProfileChange === undefined) {
          return {
            ok: false,
            content: '当前无法提交 Profile 修改建议（审批服务未就绪）。',
            errorCode: 'NOT_SUPPORTED',
          };
        }
        memory.submitProfileChange(identity, params.changes, params.reason);
        return {
          ok: true,
          content:
            '修改建议已作为审批卡发给用户，等用户决定（可能需要一段时间）。用户决定后宿主会通知你结果；在此之前不要声称已经修改，也不要重复提议。',
        };
      }
      try {
        const outcome = await memory.requestProfileChange(
          identity,
          params.changes,
          params.reason,
          toolCtx.signal,
        );
        if (outcome.approved) {
          return { ok: true, content: `用户已批准 Profile 修改并写入。${outcome.note}` };
        }
        return {
          ok: false,
          content: `用户未批准该 Profile 修改（${outcome.note}）。不要反复重试，可以在自己的自我笔记（self_note）里记下你的想法。`,
          errorCode: 'APPROVAL_DENIED',
        };
      } catch (error) {
        if (error instanceof AppError && error.code === 'APPROVAL_DENIED') {
          return { ok: false, content: '用户拒绝或取消了该建议。', errorCode: 'APPROVAL_DENIED' };
        }
        throw error;
      }
    },
  };

  return [
    remember,
    recallMemory,
    getUserProfile,
    listCommitments,
    memoryFeedback,
    forget,
    proposeProfileChange,
  ];
}
