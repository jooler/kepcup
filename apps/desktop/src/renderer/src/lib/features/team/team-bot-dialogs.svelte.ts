import type { TeamBotView, TeamModelOption } from '@kepcup/shared';
import type { SourceId } from '$lib/rpc/connections.svelte';
import {
  teamBots,
  type TeamBotCapabilities,
  type TeamBotCreateInput,
  type TeamBotPatchInput,
} from './team-bots.svelte';

/**
 * 团队建 Bot / 编辑 Bot 对话框的表单逻辑（member-bots B4 子域 A）。组件
 *（TeamCreateBotDialog / TeamBotEditDialog）是薄视图；这里持状态与判定，测试
 * 直击本模块（无 DOM mount 基建，repo 惯例同 resolution-card）。
 *
 * 服务端语义（B2 bots-member.ts）：patch 子结构整体替换（表单没碰的子结构不
 * 发）；name 生效上限 50（传输层 120，超限提前拒 INVALID_INPUT）；public 门槛 /
 * 配额 / 工作路径边界全在服务端，客户端只做前置禁用与错误码呈现。
 */

/** core botIdentitySchema 的 name 生效上限（传输层 120 > 生效上限 50）。 */
export const TEAM_BOT_NAME_MAX = 50;

export interface TeamBotCreateOutcome {
  ok: boolean;
  /** 失败时的服务端错误码（BOT_LIMIT_REACHED / FORBIDDEN / WORKDIR_NOT_ALLOWED…）。 */
  code?: string;
  bot?: TeamBotView;
}

export interface TeamCreateBotHooks {
  /**
   * 创建 + 跳转访谈会话（bot-setup 的团队版入口；注入以便测试不复刻导航）。
   * 返回结果后对话框自行收尾（onClose 由组件处理）。
   */
  submit(input: TeamBotCreateInput): Promise<TeamBotCreateOutcome>;
  /** 对话框打开时刷新 store（配额 / 权限以最新为准）。 */
  refresh?(): Promise<void>;
}

export class TeamCreateBotState {
  readonly source: SourceId;
  mode = $state<'private' | 'public'>('private');
  /** 留空 = 不带 name，走访谈让 Bot 自己问。 */
  name = $state('');
  /** null = 「自动分配专属目录」（服务端缺省绑 members/<mbrId>/bots/<botId>/）。 */
  workdirPath = $state<string | null>(null);
  submitting = $state(false);
  /** 最近一次创建失败的服务端错误码（成功 / 未提交为 null）。 */
  errorCode = $state<string | null>(null);

  readonly #hooks: TeamCreateBotHooks;

  constructor(source: SourceId, hooks: TeamCreateBotHooks) {
    this.source = source;
    this.#hooks = hooks;
  }

  /** bootstrap 的能力面（旧服务端无 botCapabilities → null：隐藏公共档、不显配额）。 */
  get capabilities(): TeamBotCapabilities | null {
    return teamBots.botCapabilitiesOf(this.source);
  }

  get publicAllowed(): boolean {
    return this.capabilities?.canCreatePublicBot === true;
  }

  /** 私有 Bot 配额（unknown = 旧服务端，不显示）。 */
  get quota(): { used: number; limit: number } | null {
    const caps = this.capabilities;
    return caps === null ? null : { used: caps.privateBotsUsed, limit: caps.privateBotsLimit };
  }

  /** 配额满（含 limit=0 = 创建关闭）：前置禁用，服务端仍兜底拒 BOT_LIMIT_REACHED。 */
  get quotaFull(): boolean {
    const quota = this.quota;
    return quota !== null && quota.limit <= quota.used;
  }

  get nameInvalid(): boolean {
    return this.name.trim().length > TEAM_BOT_NAME_MAX;
  }

  get createDisabled(): boolean {
    if (this.submitting || this.nameInvalid) return true;
    return this.mode === 'private' && this.quotaFull;
  }

  /** mode=public 而权限被收回（caps 刷新后）：回退私有档，避免提交必拒。 */
  normalizeMode(): void {
    if (this.mode === 'public' && !this.publicAllowed) this.mode = 'private';
  }

  async init(): Promise<void> {
    await this.#hooks.refresh?.();
    this.normalizeMode();
  }

  /**
   * 创建（成功即已跳转访谈会话，组件随后 onClose）。失败置 errorCode 供内联
   * 呈现（BOT_LIMIT_REACHED → teamBot.limitReached）。
   */
  async submit(): Promise<boolean> {
    if (this.createDisabled) return false;
    const input: TeamBotCreateInput = {
      mode: this.mode,
      ...(this.name.trim().length > 0 ? { name: this.name.trim() } : {}),
      ...(this.workdirPath !== null ? { workdirPath: this.workdirPath } : {}),
    };
    this.submitting = true;
    this.errorCode = null;
    try {
      const result = await this.#hooks.submit(input);
      if (result.ok) return true;
      this.errorCode = result.code ?? 'INTERNAL';
      // 配额可能在打开对话框后被其它端占满：刷新一次能力面。
      await this.#hooks.refresh?.();
      this.normalizeMode();
      return false;
    } finally {
      this.submitting = false;
    }
  }
}

// --- 编辑对话框 ----------------------------------------------------------------------

export interface TeamBotMemberLite {
  id: string;
  displayName: string;
}

export interface TeamBotEditDeps {
  load(
    source: SourceId,
    botId: string,
  ): Promise<{ profile: Record<string, unknown>; view: TeamBotView }>;
  save(source: SourceId, botId: string, patch: TeamBotPatchInput): Promise<TeamBotView>;
  transfer(source: SourceId, botId: string, toMemberId: string): Promise<TeamBotView>;
  remove(source: SourceId, botId: string): Promise<void>;
  models(source: SourceId): Promise<TeamModelOption[]>;
  members(source: SourceId): Promise<TeamBotMemberLite[]>;
}

export const teamBotEditDeps: TeamBotEditDeps = {
  load: (source, botId) => teamBots.loadTeamBotProfile(source, botId),
  save: (source, botId, patch) => teamBots.updateBot(source, botId, patch),
  transfer: (source, botId, toMemberId) => teamBots.transferBot(source, botId, toMemberId),
  remove: (source, botId) => teamBots.deleteBot(source, botId),
  models: (source) => teamBots.modelOptions(source),
  members: (source) => teamBots.listMembers(source),
};

interface BotProfileForm {
  identity: { name: string; bio: string; avatar?: string };
  persona: {
    personality: string;
    tone: string;
    style: string;
    values: string;
    sample_dialogues: string;
  };
  role: { expertise: string; responsibilities: string };
  boundaries: string[];
  behavior: { proactive: boolean; quiet_hours: [string, string] | null; max_proactive_per_day: number | null };
  runtime: Record<string, unknown>;
}

/** 宽松读取（bots.get 的 profile 已过 core schema，这里只做表单基线提取）。 */
function formOf(profile: Record<string, unknown>): BotProfileForm {
  const identity = (profile.identity ?? {}) as BotProfileForm['identity'];
  const persona = (profile.persona ?? {}) as BotProfileForm['persona'];
  const role = (profile.role ?? {}) as BotProfileForm['role'];
  const behavior = (profile.behavior ?? {}) as BotProfileForm['behavior'];
  return {
    identity: {
      name: identity.name ?? '',
      bio: identity.bio ?? '',
      ...(identity.avatar !== undefined ? { avatar: identity.avatar } : {}),
    },
    persona: {
      personality: persona.personality ?? '',
      tone: persona.tone ?? '',
      style: persona.style ?? '',
      values: persona.values ?? '',
      sample_dialogues: persona.sample_dialogues ?? '',
    },
    role: { expertise: role.expertise ?? '', responsibilities: role.responsibilities ?? '' },
    boundaries: Array.isArray(profile.boundaries) ? (profile.boundaries as string[]) : [],
    behavior: {
      proactive: behavior.proactive !== false,
      quiet_hours: behavior.quiet_hours ?? null,
      max_proactive_per_day: behavior.max_proactive_per_day ?? null,
    },
    runtime: { ...((profile.runtime as Record<string, unknown>) ?? {}) },
  };
}

export class TeamBotEditState {
  readonly source: SourceId;
  readonly botId: string;
  loading = $state(true);
  loadError = $state<string | null>(null);
  /** 成员面视图行（mode / canEdit / workdirPath / setupState）。 */
  view = $state<TeamBotView | null>(null);
  modelOptions = $state<TeamModelOption[]>([]);
  /** 转交候选（active 成员，不含自己；仅私有 Bot 展示）。 */
  members = $state<TeamBotMemberLite[]>([]);
  transferMemberId = $state<string | null>(null);
  /** 删除二次确认。 */
  confirmingDelete = $state(false);
  saving = $state(false);
  transferring = $state(false);
  deleting = $state(false);
  saveError = $state<string | null>(null);
  transferError = $state<string | null>(null);
  deleteError = $state<string | null>(null);

  // --- 表单字段（加载后从 profile 基线绑定）------------------------------------------
  name = $state('');
  bio = $state('');
  personality = $state('');
  tone = $state('');
  style = $state('');
  values = $state('');
  sampleDialogues = $state('');
  expertise = $state('');
  responsibilities = $state('');
  boundariesText = $state('');
  proactive = $state(true);
  /** '' = 跟随服务器默认（runtime.model 置空）。 */
  model = $state('');
  /** undefined = 保持当前绑定（不进 patch）；选了选项即整体替换。 */
  workdirPath = $state<string | undefined>(undefined);

  #form: BotProfileForm | null = null;
  readonly #deps: TeamBotEditDeps;

  constructor(source: SourceId, botId: string, deps: TeamBotEditDeps = teamBotEditDeps) {
    this.source = source;
    this.botId = botId;
    this.#deps = deps;
  }

  async init(): Promise<void> {
    try {
      const [loaded, models, members] = await Promise.all([
        this.#deps.load(this.source, this.botId),
        this.#deps.models(this.source),
        this.#deps.members(this.source),
      ]);
      this.#form = formOf(loaded.profile);
      this.view = loaded.view;
      this.name = this.#form.identity.name;
      this.bio = this.#form.identity.bio;
      this.personality = this.#form.persona.personality;
      this.tone = this.#form.persona.tone;
      this.style = this.#form.persona.style;
      this.values = this.#form.persona.values;
      this.sampleDialogues = this.#form.persona.sample_dialogues;
      this.expertise = this.#form.role.expertise;
      this.responsibilities = this.#form.role.responsibilities;
      this.boundariesText = this.#form.boundaries.join('\n');
      this.proactive = this.#form.behavior.proactive;
      this.model = typeof this.#form.runtime['model'] === 'string' ? this.#form.runtime['model'] : '';
      this.modelOptions = models;
      // 当前模型不在服务器启用列表：保留一项标记不可用（值仍可显示与清除）。
      if (
        this.model.length > 0 &&
        !models.some((option) => option.id === this.model)
      ) {
        this.modelOptions = [
          ...models,
          { id: this.model, label: this.model },
        ];
      }
      const selfId = teamBots.selfMemberIdOf(this.source);
      this.members = members.filter((member) => member.id !== selfId);
      this.loadError = null;
    } catch (error) {
      this.loadError = errorCodeOf(error);
    } finally {
      this.loading = false;
    }
  }

  get isPrivate(): boolean {
    return this.view?.mode === 'private';
  }

  /** 当前绑定的工作路径（未改动时 patch 不含 workdirPath）。 */
  get currentWorkdirPath(): string | undefined {
    return this.view?.workdirPath;
  }

  get nameInvalid(): boolean {
    return this.name.trim().length === 0 || this.name.trim().length > TEAM_BOT_NAME_MAX;
  }

  get saveDisabled(): boolean {
    return this.loading || this.view === null || this.nameInvalid || this.saving;
  }

  get transferDisabled(): boolean {
    return (
      this.transferring ||
      this.transferMemberId === null ||
      this.transferMemberId.length === 0
    );
  }

  /**
   * patch 组装：表单涉及的子结构整体发（服务端按子结构整体替换）；没碰的
   * 子结构（runtime 其余字段 / behavior 的 quiet_hours 等）以加载基线回填，
   * avatar 原样保留。
   */
  buildPatch(): TeamBotPatchInput {
    const form = this.#form ?? formOf({});
    const boundaries = this.boundariesText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return {
      identity: {
        ...form.identity,
        name: this.name.trim(),
        bio: this.bio,
      },
      persona: {
        personality: this.personality,
        tone: this.tone,
        style: this.style,
        values: this.values,
        sample_dialogues: this.sampleDialogues,
      },
      role: { expertise: this.expertise, responsibilities: this.responsibilities },
      boundaries,
      behavior: { ...form.behavior, proactive: this.proactive },
      runtime: { ...form.runtime, model: this.model },
      ...(this.workdirPath !== undefined ? { workdirPath: this.workdirPath } : {}),
    };
  }

  /** 保存参数（team.bots.update）。成功返回 true（视图行由 store 事件收敛）。 */
  async save(): Promise<boolean> {
    if (this.saveDisabled) return false;
    this.saving = true;
    this.saveError = null;
    try {
      const view = await this.#deps.save(this.source, this.botId, this.buildPatch());
      this.view = view;
      return true;
    } catch (error) {
      this.saveError = errorCodeOf(error);
      return false;
    } finally {
      this.saving = false;
    }
  }

  /** 转交私有 Bot（team.bots.transfer）：目标配额满 → BOT_LIMIT_REACHED。 */
  async transfer(): Promise<boolean> {
    if (this.transferDisabled) return false;
    const target = this.transferMemberId!;
    this.transferring = true;
    this.transferError = null;
    try {
      await this.#deps.transfer(this.source, this.botId, target);
      return true;
    } catch (error) {
      this.transferError = errorCodeOf(error);
      return false;
    } finally {
      this.transferring = false;
    }
  }

  /** 删除（team.bots.delete；组件层已二次确认）。 */
  async remove(): Promise<boolean> {
    if (this.deleting) return false;
    this.deleting = true;
    this.deleteError = null;
    try {
      await this.#deps.remove(this.source, this.botId);
      return true;
    } catch (error) {
      this.deleteError = errorCodeOf(error);
      return false;
    } finally {
      this.deleting = false;
    }
  }
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: string } | undefined)?.code;
  return typeof code === 'string' ? code : 'INTERNAL';
}
