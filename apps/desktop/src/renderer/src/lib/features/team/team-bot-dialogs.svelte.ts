import type { BotProfile, TeamBotView, TeamModelOption } from '@kepcup/shared';
import type { SourceId } from '$lib/rpc/connections.svelte';
import { teamBots, type TeamBotPatchInput, type TeamBotsSlice } from './team-bots.svelte';

/**
 * 团队编辑 Bot 对话框的表单逻辑（member-bots B4 子域 A）。组件
 *（TeamBotEditDialog）是薄视图；这里持状态与判定，测试直击本模块（无 DOM
 * mount 基建，repo 惯例同 resolution-card）。
 *
 * 建侧状态（原 TeamCreateBotState，2026-11「+」菜单重构）随对话框一并移除：
 * 菜单项直调 createTeamBotConversational（无对话框），参数在访谈里完善。
 *
 * 服务端语义（B2 bots-member.ts）：patch 子结构整体替换（表单没碰的子结构不
 * 发）；name 生效上限 50（传输层 120，超限提前拒 INVALID_INPUT）；public 门槛 /
 * 配额 / 工作路径边界全在服务端，客户端只做前置禁用与错误码呈现。
 */

/** core botIdentitySchema 的 name 生效上限（传输层 120 > 生效上限 50）。 */
export const TEAM_BOT_NAME_MAX = 50;

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

// --- Bot 详情面板「移除 Bot」行的成员面判定 ------------------------------------------

/** 面板删除行的判定结果（RightPanel 的「移除 Bot」入口按 kind 分派）。 */
export type BotPanelRemoveAction =
  | { kind: 'team'; source: SourceId; view: TeamBotView }
  | { kind: 'local' }
  | { kind: 'hidden' };

/**
 * Bot 详情面板「移除 Bot」行的成员面判定（sidebar-team-group `botRowMenuAction`
 * 的姊妹函数，同「resolved 才判定」口径）：团队服务器上 core `bots.delete` /
 * `bots.deletionPreview` 对成员一律 deny（method-policy 的 bot-edit 拒绝面），
 * 面板旧链路「点击无反应」即源于此——
 * - 团队上下文（web 端点成员面在 'local'；桌面融合取当前对话来源）：成员面
 *   Bot 且调用者是所有者（canDelete）→ `{ kind: 'team' }` 改走
 *   `team.bots.delete`；清单未解析 / 非成员面 Bot（butler、管理员共享）/
 *   非所有者 → 隐藏该行（服务端这些写面已 403，前端按同一规则隐藏，B-3 惯例）；
 * - 非团队上下文 → `{ kind: 'local' }` 维持本地 core 删除链路不变。
 */
export function botPanelRemoveAction(input: {
  teamActive: boolean;
  /** 当前对话来源（'local' 或 `team:<hash>`；无会话为 'local' 缺省）。 */
  conversationSource: SourceId;
  botId: string | null;
  /** 面板既有判定：管家等系统角色不可删。 */
  systemButler: boolean;
  /** 成员面切片读取（生产传 teamBotsOf；注入便于单测）。 */
  resolveSlice: (source: SourceId) => TeamBotsSlice;
}): BotPanelRemoveAction {
  if (input.botId === null || input.systemButler) return { kind: 'hidden' };
  // 成员面所在来源：web 团队端点恒 'local'（同源 core 即团队服务器）；桌面
  // 融合看团队对话时为该来源；本机对话（非团队上下文）为 null → 本地链路。
  const source = input.teamActive
    ? 'local'
    : (input.conversationSource !== 'local' ? input.conversationSource : null);
  if (source === null) return { kind: 'local' };
  const slice = input.resolveSlice(source);
  if (!slice.loaded) return { kind: 'hidden' };
  const view = slice.bots.find((bot) => bot.id === input.botId);
  if (view === undefined || !view.canDelete) return { kind: 'hidden' };
  return { kind: 'team', source, view };
}

// --- Bot 详情面板「保存 / 工作路径」的成员面判定 ------------------------------------

/** 面板保存分派的判定结果（RightPanel 的 Profile 写入按 kind 分派）。 */
export type BotPanelEditAction =
  | { kind: 'team'; source: SourceId; view: TeamBotView }
  | { kind: 'local' };

/**
 * Bot 详情面板「参数编辑」的成员面判定（botPanelRemoveAction 的姊妹函数，同
 * 「resolved 才判定」口径）：团队服务器上 core `bots.update` / `bots.avatar.*`
 * 对成员一律 deny（method-policy 的 bot-edit 拒绝面）——右栏旧链路「改了参数
 * 静默 403」即源于此。所有者 Bot（canEdit）→ `{ kind: 'team' }`，右栏的保存
 * 与工作路径改绑改走 `team.bots.update`；其余回退 `{ kind: 'local' }`（本机
 * Bot 的既有链路；团队上的非所有者 / butler 由服务端拒绝面兜底）。
 */
export function botPanelEditAction(input: {
  teamActive: boolean;
  /** 当前对话来源（'local' 或 `team:<hash>`；无会话为 'local' 缺省）。 */
  conversationSource: SourceId;
  botId: string | null;
  /** 成员面切片读取（生产传 teamBotsOf；注入便于单测）。 */
  resolveSlice: (source: SourceId) => TeamBotsSlice;
}): BotPanelEditAction {
  if (input.botId === null) return { kind: 'local' };
  // 成员面所在来源：web 团队端点恒 'local'（同源 core 即团队服务器）；桌面
  // 融合看团队对话时为该来源；本机对话（非团队上下文）为 null → 本地链路。
  const source = input.teamActive
    ? 'local'
    : (input.conversationSource !== 'local' ? input.conversationSource : null);
  if (source === null) return { kind: 'local' };
  const slice = input.resolveSlice(source);
  if (!slice.loaded) return { kind: 'local' };
  const view = slice.bots.find((bot) => bot.id === input.botId);
  if (view === undefined || !view.canEdit) return { kind: 'local' };
  return { kind: 'team', source, view };
}

/**
 * 右栏整份 Profile → `team.bots.update` 的 patch：服务端按子结构整体替换、再
 * 三方合并回当前 Profile（bots-member.ts `botsUpdate`），与右栏表单「整份草稿
 * 自动保存」的形状一一对应。子结构浅拷贝即可——传输层 Zod parse 会按 schema
 * 收敛 / 剥离未知键；runtime 模型与 MCP 清单由服务端 sanitizeRuntime 校验。
 */
export function teamBotPatchOfProfile(profile: BotProfile): TeamBotPatchInput {
  return {
    identity: { ...profile.identity },
    persona: { ...profile.persona },
    role: { ...profile.role },
    boundaries: [...profile.boundaries],
    behavior: { ...profile.behavior },
    runtime: { ...profile.runtime },
  };
}

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
  /** 成员面视图行（mode / canEdit / workdirKey+Name / setupState）。 */
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
  /** undefined = 保持当前绑定（不进 patch）；选了选项即整体替换（opaque key）。 */
  workdirKey = $state<string | undefined>(undefined);

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

  /**
   * 当前绑定的工作路径展示名（未改动时 patch 不含 workdirKey）。name 缺失（坏 /
   * 旧服务端只回其一）兜底展示 opaque key——有绑定显示真键，好过误报「未绑定」。
   */
  get currentWorkdirName(): string | undefined {
    return this.view?.workdirName ?? this.view?.workdirKey;
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
      ...(this.workdirKey !== undefined ? { workdirKey: this.workdirKey } : {}),
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
