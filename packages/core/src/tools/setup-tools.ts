import { Type } from '@earendil-works/pi-ai';
import {
  SETUP_MAX_QUESTIONS,
  SETUP_QUESTION_OPTIONS_MAX,
  SETUP_QUESTION_OPTIONS_MIN,
  type GroupSetupStep,
} from '@kepcup/shared';
import type { RunIdentity, ToolDefinition } from '../agent/types.js';
import { PROFILE_CHANGE_FIELDS } from './memory-tools.js';

/**
 * 对话式新建（setup interview）专属工具（UI 改版）：仅在 bots.setup_state =
 * 'interviewing' 时注册。与 propose_profile_change 的「审批卡」路径不同，
 * 访谈期间 Bot 对自己 profile 的写入是这次创建流程的明确目的，直接生效
 * （字段白名单仍然收口，identity.name 仅在此流程可写）。
 *
 * 问题交互（参考 Grok）：首问由 core 在 interview.start 时确定性下发
 * （见 BEGIN_* 常量）；之后每问都必须走 ask_question 工具——它把
 * 「确认语 + 问题 + 候选答案」落成消息卡片（自定义回答输入框由界面
 * 永久提供，不属于候选），并终止本轮 run（finalText 不再发送）。
 */

/** Opening bot bubble, inserted verbatim by bots.interview.start. */
export const SETUP_GREETING =
  '你好，很高兴认识你！我是你的新助手。先花一分钟了解你，我就能知道该怎么帮你了。';
/** Fixed first question (deterministic, no LLM) — shown as a question card. */
export const SETUP_FIRST_QUESTION = '您希望我协助您处理哪些事务？';
/** Candidate answers of the fixed first question; the UI appends a custom input. */
export const SETUP_FIRST_OPTIONS = [
  '写作与文档',
  '编程与开发',
  '数据分析与报告',
  '营销与增长',
] as const;

/**
 * Fixed work-directory question (docs/design/19 D59): inserted by core right
 * after the first interview answer, before any LLM call. The card offers the
 * native directory picker and a skip exit; the answer (or skip note) travels
 * to the model with the buffered first answer.
 */
export const SETUP_PATH_QUESTION =
  '为了让后续的文件处理有个固定的地方，请为这次对话选择一个工作目录。';
/** setupAnswer text recorded when the user skips the directory question. */
export const SETUP_PATH_SKIP_TEXT = '暂不设置工作目录';

/**
 * Group-creation questions per step (docs/design/19 D60): all deterministic,
 * zero model calls — cards carry the step, the UI renders the matching form.
 */
export const GROUP_SETUP_QUESTIONS: Record<GroupSetupStep, string> = {
  title: '请给这个群起个名字。',
  purpose: '这个群主要用来处理什么事务？（群里的 Bot 会以此了解自己的定位）',
  members: '请选择加入这个群的成员（至少 2 个）。',
  project: '最后，请为这个群选择一个工作目录（之后随时可以再改）。',
};

/** The slice of BotsService (plus event publishing) the setup tools need. */
export interface SetupToolFacade {
  /** Applies extracted fields to the bot profile directly + publishes bot.updated. */
  saveProfile(
    botId: string,
    changes: Array<{ field: string; value: string }>,
  ): { ok: boolean; message: string };
  /** Clears setup_state ('interviewing' → null) + publishes bot.updated. */
  finishSetup(botId: string): { ok: boolean; message: string };
  /**
   * Persists one interview question (optional acknowledgement bubble + question
   * card with candidate options) and reports progress against the question cap.
   */
  askQuestion(
    botId: string,
    input: { acknowledgement?: string; question: string; options: string[] },
  ): { ok: boolean; message: string };
}

export const SETUP_PROFILE_FIELDS = ['identity.name', ...PROFILE_CHANGE_FIELDS] as const;

export function buildSetupTools(input: {
  identity: RunIdentity;
  setup: SetupToolFacade;
}): ToolDefinition[] {
  const { identity, setup } = input;

  const saveProfile: ToolDefinition<{
    changes: Array<{ field: string; value: string }>;
  }> = {
    name: 'save_profile',
    description:
      '把你从用户回答中提炼的信息写入你自己的 Profile（初始化访谈期间可直接生效，无需审批）。field 只能是：identity.name、identity.bio、persona.personality、persona.tone、persona.style、persona.values、persona.sample_dialogues、role.expertise、role.responsibilities。只提交用户实际说过的内容。',
    parameters: Type.Object({
      changes: Type.Array(Type.Object({ field: Type.String(), value: Type.String() }), {
        description: '要写入的字段与内容',
      }),
    }),
    execute: async (params) => {
      if (identity.botId === null) {
        return {
          ok: false,
          content: '当前执行没有 Bot 上下文，无法保存 profile',
          errorCode: 'INVALID_INPUT',
        };
      }
      const invalid = params.changes.filter(
        (change) => !(SETUP_PROFILE_FIELDS as readonly string[]).includes(change.field),
      );
      if (invalid.length > 0 || params.changes.length === 0) {
        return {
          ok: false,
          content: `field 只能是：${SETUP_PROFILE_FIELDS.join('、')}`,
          errorCode: 'INVALID_INPUT',
        };
      }
      const result = setup.saveProfile(identity.botId, params.changes);
      return result.ok
        ? { ok: true, content: result.message }
        : { ok: false, content: result.message, errorCode: 'INVALID_INPUT' };
    },
  };

  const askQuestion: ToolDefinition<{
    acknowledgement?: string;
    question: string;
    options: string[];
  }> = {
    name: 'ask_question',
    description:
      '向用户提出下一个初始化问题（访谈中提问只能用这个工具）。会以卡片形式展示问题与候选答案，用户点选或自行输入后回答你。acknowledgement 是对上一条回答的简短确认（可选）。options 给 2~4 个贴合用户情况的候选答案——不必放「其他」之类兜底项，界面会自动提供自定义输入。调用后本轮立即结束，所以它必须是本轮最后一个动作。',
    parameters: Type.Object({
      acknowledgement: Type.Optional(
        Type.String({ description: '对用户上一条回答的简短确认，可为空' }),
      ),
      question: Type.String({ description: '下一个问题，一次只问一个' }),
      options: Type.Array(Type.String(), {
        description: `候选答案，${SETUP_QUESTION_OPTIONS_MIN}~${SETUP_QUESTION_OPTIONS_MAX} 个`,
      }),
    }),
    execute: async (params) => {
      if (identity.botId === null) {
        return { ok: false, content: '当前执行没有 Bot 上下文', errorCode: 'INVALID_INPUT' };
      }
      const question = params.question.trim();
      const acknowledgement = params.acknowledgement?.trim() || undefined;
      const options = params.options.map((option) => option.trim()).filter((o) => o.length > 0);
      if (question.length === 0) {
        return { ok: false, content: '问题不能为空', errorCode: 'INVALID_INPUT' };
      }
      if (
        options.length < SETUP_QUESTION_OPTIONS_MIN ||
        options.length > SETUP_QUESTION_OPTIONS_MAX
      ) {
        return {
          ok: false,
          content: `候选答案必须是 ${SETUP_QUESTION_OPTIONS_MIN}~${SETUP_QUESTION_OPTIONS_MAX} 个非空字符串`,
          errorCode: 'INVALID_INPUT',
        };
      }
      const result = await setup.askQuestion(identity.botId, {
        ...(acknowledgement !== undefined ? { acknowledgement } : {}),
        question,
        options,
      });
      if (!result.ok) {
        return { ok: false, content: result.message, errorCode: 'INVALID_INPUT' };
      }
      // 问题卡片已落库：终止本轮且不再发 finalText（顺序与去重都由工具保证）。
      return { ok: true, content: result.message, terminate: true };
    },
  };

  const finishSetup: ToolDefinition<Record<string, never>> = {
    name: 'finish_setup',
    description:
      '结束你的初始化访谈：调用后你进入正常运行状态（访谈指引与 setup 工具随即失效）。请在向用户确认信息已保存后再调用。',
    parameters: Type.Object({}),
    execute: async () => {
      if (identity.botId === null) {
        return { ok: false, content: '当前执行没有 Bot 上下文', errorCode: 'INVALID_INPUT' };
      }
      const result = setup.finishSetup(identity.botId);
      return result.ok
        ? { ok: true, content: result.message }
        : { ok: false, content: result.message, errorCode: 'INVALID_INPUT' };
    },
  };

  return [saveProfile, askQuestion, finishSetup];
}

/** Question-cap enforcement message shared by the facade implementations. */
export function questionCapReached(): { ok: false; message: string } {
  return {
    ok: false,
    message: `已达 ${SETUP_MAX_QUESTIONS} 个问题的上限，不能再提问：请直接调用 save_profile 保存已有信息，然后调用 finish_setup 结束访谈。`,
  };
}
