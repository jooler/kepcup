import type {
  TeamBotView,
  TeamModelOption,
  TeamWorkdirOption,
} from '@kepcup/shared';
import {
  connections,
  serverHashOf,
  teamSourceId,
  type SourceId,
} from '$lib/rpc/connections.svelte';

/**
 * 成员侧 Bot 面的客户端状态（member-bots B4 子域 A）：每个团队来源一份切片，
 * 持 `team.bots.list` 的可见 Bot 视图与 bootstrap 写入的 `botCapabilities`。
 * 参数变更 / 删除 / 转交的传播复用该来源连接上的 core `bot.updated` /
 * `bot.deleted` 事件（B-12）——载荷不含成员面视图，事件到达即重拉列表收敛
 * （列表小、重拉最省心智，与 friends store 同模式）。
 *
 * 休眠铁律：切片只在 UI 显式调用 `loadTeamBots` 后才存在；事件 / 重连刷新都以
 * 「该来源切片已成功加载过」为闸——个人版 core（无团队层）上从不拉取、不报错，
 * 不连接团队服务器时全部消费点行为与现状一致。
 *
 * 当前成员 id：桌面融合来源取 `connections.get(source).memberId`；web 团队端点
 *（source = 'local'）由 team-context 在 bootstrap 后经 `setTeamMemberId` 写入
 *（避免与 team-context 互相 import 造成环）。
 */

export interface TeamBotCapabilities {
  canCreatePublicBot: boolean;
  privateBotsUsed: number;
  privateBotsLimit: number;
}

export interface TeamBotsSlice {
  bots: TeamBotView[];
  /** 至少成功拉取过一次（失败 / 从未拉取为 false，UI 显示占位）。 */
  loaded: boolean;
  /** 最近一次拉取失败的服务端错误码（成功后清空）。 */
  error?: string;
}

/** `team.bots.create` 的输入（对话框组装；name 传已 trim 的非空值）。 */
export interface TeamBotCreateInput {
  mode: 'private' | 'public';
  name?: string;
  workdirPath?: string;
}

export interface TeamBotPatchInput {
  identity?: Record<string, unknown>;
  persona?: Record<string, unknown>;
  role?: Record<string, unknown>;
  boundaries?: string[];
  behavior?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  workdirPath?: string;
}

function emptySlice(): TeamBotsSlice {
  return { bots: [], loaded: false };
}

class TeamBotsState {
  slices = $state<Record<string, TeamBotsSlice>>({});
  /** bootstrap 的 botCapabilities（B1 契约；旧服务端无该字段 → null = 无成员 Bot 面）。 */
  capabilities = $state<Record<string, TeamBotCapabilities | null>>({});
  /**
   * 当前成员 id（team-context / contacts 的 bootstrap 消费写入；桌面融合来源
   * 走连接自带 memberId）。响应式：myPrivateBotsOf / botCapabilitiesOf 在组件
   * $derived 里读它，写入晚于派生首次计算时也要触发重算。
   */
  #memberIds = $state<Record<string, string | null>>({});
  #started = false;
  /** 已接线的连接实例（按实例而非来源键：断开重连换新连接对象）。 */
  readonly #wired = new Set<object>();
  readonly #unsubscribers: Array<() => void> = [];

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#unsubscribers.push(connections.onSourcesChanged(() => this.#wireSources()));
    this.#wireSources();
  }

  /** 来源 → 切片键（'local' 或 serverHash）。 */
  #keyOf(source: SourceId): string {
    return source === 'local' ? 'local' : (serverHashOf(source) ?? 'local');
  }

  #sourceOf(key: string): SourceId {
    return key === 'local' ? 'local' : teamSourceId(key);
  }

  // --- 读口（响应式：在组件的 $derived / $effect 内调用即随切片更新）----------------

  teamBotsOf(source: SourceId): TeamBotsSlice {
    return this.slices[this.#keyOf(source)] ?? emptySlice();
  }

  /**
   * botCapabilities（旧服务端无 → null）。privateBotsUsed 以已加载的列表实时折算
   * （创建 / 删除 / 转交后无需重跑 bootstrap）；canCreatePublicBot / limit 仍以
   * bootstrap 为准——它们只有管理面能改。
   */
  botCapabilitiesOf(source: SourceId): TeamBotCapabilities | null {
    const key = this.#keyOf(source);
    const caps = this.capabilities[key];
    if (caps == null) return null;
    const slice = this.slices[key];
    if (slice?.loaded) {
      const memberId = this.selfMemberIdOf(source);
      const used = slice.bots.filter(
        (bot) => bot.mode === 'private' && bot.ownerMemberId === memberId,
      ).length;
      if (used !== caps.privateBotsUsed) return { ...caps, privateBotsUsed: used };
    }
    return caps;
  }

  /** 我的私有 Bot（mode private ∧ owner = 当前成员；成员 id 未知为空数组）。 */
  myPrivateBotsOf(source: SourceId): TeamBotView[] {
    const memberId = this.selfMemberIdOf(source);
    if (memberId === null) return [];
    return this.teamBotsOf(source).bots.filter(
      (bot) => bot.mode === 'private' && bot.ownerMemberId === memberId,
    );
  }

  /** 当前成员 id：显式 setter 优先，其次桌面融合连接自带的 memberId。 */
  selfMemberIdOf(source: SourceId): string | null {
    const key = this.#keyOf(source);
    const explicit = this.#memberIds[key];
    if (explicit !== undefined && explicit !== null) return explicit;
    if (source !== 'local') return connections.get(source).memberId;
    return null;
  }

  // --- 写口（team-context bootstrap 消费；B 子域调用）-----------------------------

  setTeamBotCapabilities(source: SourceId, caps: TeamBotCapabilities | null): void {
    const key = this.#keyOf(source);
    this.capabilities = { ...this.capabilities, [key]: caps };
  }

  setTeamMemberId(source: SourceId, memberId: string | null): void {
    this.#memberIds[this.#keyOf(source)] = memberId;
  }

  // --- 数据面 -----------------------------------------------------------------------

  /** 拉取该来源的成员面 Bot 列表（失败写 error、loaded 保持上次值）。 */
  async loadTeamBots(source: SourceId): Promise<void> {
    const key = this.#keyOf(source);
    this.start();
    this.#wireSource(source);
    try {
      const result = (await connections.get(source).callTeam('team.bots.list')) as {
        bots: TeamBotView[];
      };
      this.slices = {
        ...this.slices,
        [key]: { bots: result.bots, loaded: true },
      };
    } catch (error) {
      const previous = this.slices[key] ?? emptySlice();
      this.slices = {
        ...this.slices,
        [key]: { ...previous, error: errorCodeOf(error) },
      };
    }
  }

  /** 成员面 Bot 的完整 Profile（编辑对话框的表单基线；可见性由服务端判定）。 */
  async loadTeamBotProfile(source: SourceId, botId: string): Promise<{
    profile: Record<string, unknown>;
    view: TeamBotView;
  }> {
    const [bot, list] = await Promise.all([
      connections.get(source).call('bots.get', { id: botId }),
      connections.get(source).callTeam('team.bots.list'),
    ]);
    const view = (list as { bots: TeamBotView[] }).bots.find((entry) => entry.id === botId) ?? null;
    if (view === null) throw new Error(`bot ${botId} not found in member plane`);
    return { profile: (bot as { bot: { profile: Record<string, unknown> } }).bot.profile, view };
  }

  async createBot(source: SourceId, input: TeamBotCreateInput): Promise<TeamBotView> {
    // name 空白串视同未给（走访谈）；transport 允许 ≤120、服务端生效上限 50，
    // 超限由对话框前置禁用 + 服务端 INVALID_INPUT 兜底。
    const name = input.name?.trim();
    const result = (await connections.get(source).callTeam('team.bots.create', {
      mode: input.mode,
      ...(name !== undefined && name.length > 0 ? { name } : {}),
      ...(input.workdirPath !== undefined && input.workdirPath !== null
        ? { workdirPath: input.workdirPath }
        : {}),
      interview: true,
    })) as { bot: TeamBotView };
    await this.loadTeamBots(source);
    return result.bot;
  }

  async updateBot(source: SourceId, botId: string, patch: TeamBotPatchInput): Promise<TeamBotView> {
    const result = (await connections.get(source).callTeam('team.bots.update', {
      botId,
      patch,
    })) as { bot: TeamBotView };
    await this.loadTeamBots(source);
    return result.bot;
  }

  async deleteBot(source: SourceId, botId: string): Promise<void> {
    await connections.get(source).callTeam('team.bots.delete', { botId });
    await this.loadTeamBots(source);
  }

  async transferBot(source: SourceId, botId: string, toMemberId: string): Promise<TeamBotView> {
    const result = (await connections.get(source).callTeam('team.bots.transfer', {
      botId,
      toMemberId,
    })) as { bot: TeamBotView };
    await this.loadTeamBots(source);
    return result.bot;
  }

  async workdirOptions(source: SourceId): Promise<TeamWorkdirOption[]> {
    const result = (await connections
      .get(source)
      .callTeam('team.bots.workdirOptions')) as { options: TeamWorkdirOption[] };
    return result.options;
  }

  async workdirMkdir(source: SourceId, name: string, parentPath?: string): Promise<string> {
    const result = (await connections.get(source).callTeam('team.bots.workdirMkdir', {
      name,
      ...(parentPath !== undefined ? { parentPath } : {}),
    })) as { path: string };
    return result.path;
  }

  async modelOptions(source: SourceId): Promise<TeamModelOption[]> {
    const result = (await connections
      .get(source)
      .callTeam('team.bots.modelOptions')) as { models: TeamModelOption[] };
    return result.models;
  }

  /** 成员名册（转交选择器 / 项目组建人流的数据源；失败回空数组）。 */
  async listMembers(source: SourceId): Promise<Array<{ id: string; displayName: string; state: string }>> {
    try {
      const result = (await connections.get(source).callTeam('team.members.list')) as {
        members: Array<{ id: string; displayName: string; state: string }>;
      };
      return result.members;
    } catch {
      return [];
    }
  }

  // --- 事件接线 ----------------------------------------------------------------------

  #wireSources(): void {
    for (const source of connections.sources()) {
      this.#wireSource(source);
    }
    // 来源被移除：丢切片（下次出现重新拉）。
    for (const key of Object.keys(this.slices)) {
      if (!connections.sources().includes(this.#sourceOf(key))) {
        const next = { ...this.slices };
        delete next[key];
        this.slices = next;
      }
    }
  }

  /**
   * 单来源接线（幂等，按连接实例）：连接重建后重拉；core `bot.updated` /
   * `bot.deleted`（成员面写操作都由服务端转发，B-12）到达即重拉。两者都闸在
   * 「已成功加载过」——未激活的来源（个人版 core / 从未打开成员 Bot 面）零副作用。
   */
  #wireSource(source: SourceId): void {
    const key = this.#keyOf(source);
    const conn = connections.get(source);
    if (this.#wired.has(conn)) return;
    this.#wired.add(conn);
    const refreshIfLoaded = (): void => {
      if (this.slices[key]?.loaded === true) void this.loadTeamBots(source);
    };
    this.#unsubscribers.push(conn.onConnected(refreshIfLoaded));
    this.#unsubscribers.push(conn.onEvent('bot.updated', refreshIfLoaded));
    this.#unsubscribers.push(conn.onEvent('bot.deleted', refreshIfLoaded));
  }

  /** 测试 teardown：清切片与接线（生产不调用——单例与页面同生命周期）。 */
  reset(): void {
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#unsubscribers.length = 0;
    this.#wired.clear();
    this.slices = {};
    this.capabilities = {};
    this.#memberIds = {};
    this.#started = false;
  }
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: string } | undefined)?.code;
  return typeof code === 'string' ? code : 'INTERNAL';
}

export const teamBots = new TeamBotsState();

// --- 模块级读写口（B4 子域 B 的接线契约：与 store 实例方法同一实现）-------------------

export function loadTeamBots(source: SourceId): Promise<void> {
  return teamBots.loadTeamBots(source);
}

export function teamBotsOf(source: SourceId): TeamBotsSlice {
  return teamBots.teamBotsOf(source);
}

export function botCapabilitiesOf(source: SourceId): TeamBotCapabilities | null {
  return teamBots.botCapabilitiesOf(source);
}

export function setTeamBotCapabilities(
  source: SourceId,
  caps: TeamBotCapabilities | null,
): void {
  teamBots.setTeamBotCapabilities(source, caps);
}

export function setTeamMemberId(source: SourceId, memberId: string | null): void {
  teamBots.setTeamMemberId(source, memberId);
}

export function myPrivateBotsOf(source: SourceId): TeamBotView[] {
  return teamBots.myPrivateBotsOf(source);
}
