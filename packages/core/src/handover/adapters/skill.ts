import type { Bot, HandoverAction, SkillEntry } from '@kepcup/shared';
import type { HandoverAdapter, HandoverContext, HandoverEntry } from '../types.js';
import { keyId } from './common.js';

/**
 * Skill（D88 P1，设计 37 §3）：一律复制，A 不变。
 *
 * - 导入的：给 B 加一行指向同一 `library_id`（不重复克隆、不再走 `skill_import` 审批——
 *   移交卡确认即授权，卡上标「外部导入」）。
 * - 自写的：目录复制进 B 的自写技能仓库，git 提交「从 {A} 复制 {name}」。
 * - B 已有同名的私有技能 → 不可执行（不覆盖）。停用 / 不兼容状态照搬。草稿（还没有生成
 *   成功的版本）与内置技能不列；公共技能所有 Bot 本来就有，也不列。
 */

export interface SkillAdapterDeps {
  skills: {
    /** The bot's private skills (bot_skills rows), as listed in the skills panel. */
    privateEntries(botId: string): SkillEntry[];
    /** One private skill of the bot (null = no private row). */
    privateEntry(botId: string, name: string): SkillEntry | null;
    /** The skill's content directory still exists. */
    contentAvailable(botId: string, name: string): boolean;
    isHandoverCopy(fromBotId: string, toBotId: string, name: string): boolean;
    copyForHandover(input: {
      fromBotId: string;
      toBotId: string;
      name: string;
      fromName: string;
    }): Promise<void>;
  };
}

const STATUS_TEXT: Partial<Record<SkillEntry['status'], string>> = {
  disabled: '已停用（复制后同样停用）',
  incompatible: '与当前环境不兼容（复制后同样不可用）',
};

function copyable(entry: SkillEntry): boolean {
  return entry.status !== 'draft' && (entry.kind === 'imported' || entry.kind === 'authored');
}

export class SkillAdapter implements HandoverAdapter {
  readonly type = 'skill' as const;
  readonly stage = 3;
  readonly #deps: SkillAdapterDeps;

  constructor(deps: SkillAdapterDeps) {
    this.#deps = deps;
  }

  owns(key: string): boolean {
    return keyId(key, 'skill') !== null;
  }

  #entry(skill: SkillEntry): HandoverEntry {
    const origin =
      skill.kind === 'imported'
        ? `外部导入${skill.sourceUrl !== null ? `，来源 ${skill.sourceUrl}` : ''}`
        : '自己写的';
    const status = STATUS_TEXT[skill.status];
    return {
      key: `skill:${skill.name}`,
      type: 'skill',
      label: skill.name,
      detail: [origin, status, skill.description]
        .filter((part) => (part ?? '').length > 0)
        .join('；'),
      actions: ['copy'],
      defaultAction: 'copy',
      // 描述与来源网址来自技能仓库或模型。
      external: true,
      marks: skill.kind === 'imported' ? ['external_import'] : [],
    };
  }

  inventory(botId: string): HandoverEntry[] {
    return this.#deps.skills
      .privateEntries(botId)
      .filter(copyable)
      .map((skill) => this.#entry(skill));
  }

  validate(ctx: HandoverContext, key: string, action: HandoverAction): string | null {
    if (action !== 'copy') return '技能只能复制';
    const name = keyId(key, 'skill') ?? '';
    const skill = this.#deps.skills.privateEntry(ctx.fromBot.id, name);
    if (skill === null || !copyable(skill)) return `${ctx.fromBot.name} 已没有技能 ${name}`;
    if (!this.#deps.skills.contentAvailable(ctx.fromBot.id, name)) {
      return `技能 ${name} 的内容已不存在（可能已被删除或回收）`;
    }
    if (ctx.toBot !== null && this.#deps.skills.privateEntry(ctx.toBot.id, name) !== null) {
      return `${ctx.toName} 已有同名技能 ${name}`;
    }
    return null;
  }

  async apply(
    ctx: HandoverContext & { toBot: Bot },
    key: string,
  ): Promise<{ result: Record<string, unknown> }> {
    const name = keyId(key, 'skill') ?? '';
    await this.#deps.skills.copyForHandover({
      fromBotId: ctx.fromBot.id,
      toBotId: ctx.toBot.id,
      name,
      fromName: ctx.fromBot.name,
    });
    return { result: { name } };
  }

  isApplied(ctx: HandoverContext & { toBot: Bot }, key: string): boolean {
    return this.#deps.skills.isHandoverCopy(
      ctx.fromBot.id,
      ctx.toBot.id,
      keyId(key, 'skill') ?? '',
    );
  }

  describe(entry: HandoverEntry, _action: HandoverAction, toName: string): string {
    const imported = entry.marks?.includes('external_import') === true;
    return imported
      ? `给 ${toName} 装上同一个版本的技能 ${entry.label}（外部导入；确认移交即授权，不再单独审批）`
      : `把技能 ${entry.label} 复制一份给 ${toName}（之后两边各改各的）`;
  }

  warnings(ctx: HandoverContext, entry: HandoverEntry): string[] {
    const skill = this.#deps.skills.privateEntry(ctx.fromBot.id, entry.label);
    if (skill === null) return [];
    const out: string[] = [];
    if (skill.kind === 'imported' && skill.compatibility === 'partial') {
      out.push('这个技能在当前环境下只能部分运行');
    }
    if (skill.missingDeps.length > 0) out.push(`缺少依赖：${skill.missingDeps.join('、')}`);
    return out;
  }
}
