import {
  AppError,
  BUILTIN_AGENT_RUNTIME,
  botProfileSchema,
  newId,
  type Bot,
  type BotProfile,
  type AgentPermissionTier,
  type BotSystemRole,
} from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { PluginDirectory } from './projects.js';

/** 对话式新建（setup interview）期间 bots.setup_state 的唯一取值。 */
export const BOT_SETUP_INTERVIEWING = 'interviewing';

/** 对话式创建时的占位名：访谈第一件事就是让 Bot 问出真正的名字。 */
export const BOT_SETUP_PLACEHOLDER_NAME = '新 Bot';

interface BotRow {
  id: string;
  name: string;
  avatar: string | null;
  bio: string | null;
  profile_json: string;
  status: 'active' | 'deleted';
  setup_state: string | null;
  system_role: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

/** Minimal valid profile for deleted placeholder rows. */
function emptyProfile(): BotProfile {
  return {
    identity: { name: '', bio: '' },
    persona: { personality: '', tone: '', style: '', values: '', sample_dialogues: '' },
    role: { expertise: '', responsibilities: '' },
    boundaries: [],
    runtime: {
      model: '',
      light_model: '',
      network_policy: 'open',
      network_allowlist: [],
      mcp_server_ids: [],
      app_connection_ids: [],
      browser_profile: '',
      message_transport: '',
      inkcop_agent_keys: [],
      agent: { ...BUILTIN_AGENT_RUNTIME },
    },
    behavior: { proactive: true, quiet_hours: null, max_proactive_per_day: null },
  };
}

/**
 * v0.4：`message_transport: inkcop-local` 曾把整轮消息 divert 到本机桥。
 * 现仅作废字段；读出时一律清空，避免旧 Bot 配置继续被误判。
 */
function stripLegacyInkcopTransport(profile: BotProfile): BotProfile {
  if (profile.runtime.message_transport !== 'inkcop-local') return profile;
  return {
    ...profile,
    runtime: { ...profile.runtime, message_transport: '' },
  };
}

function rowToBot(row: BotRow): Bot {
  const parsed = botProfileSchema.safeParse(JSON.parse(row.profile_json));
  const profile = stripLegacyInkcopTransport(parsed.success ? parsed.data : emptyProfile());
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    bio: row.bio ?? '',
    profile,
    status: row.status,
    setupState: row.setup_state === BOT_SETUP_INTERVIEWING ? BOT_SETUP_INTERVIEWING : null,
    systemRole: row.system_role === 'butler' ? 'butler' : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 新建 Bot 的默认外部 Agent（D72 P4，onboarding「我有订阅」分支）：null = 不设
 * 或当前不适用（有默认主模型、实验开关关闭、Agent 未启用…，由装配方判定）。
 */
export type DefaultAgentResolver = () => {
  id: string;
  permission: AgentPermissionTier;
  /** 设置页里该智能体的默认模型（'' = 智能体自己的默认）。 */
  model: string;
} | null;

/** `app_connection_ids` 校验所需的连接目录（`AppConnectionStore` 的子集）。 */
export interface AppConnectionDirectory {
  get(connectionId: string): { id: string; connectorId: string } | null;
}

/** D92 T1a：`markDeleted` 的负责人后盾守卫（lifecycle 先拦，这里兜底）。 */
export type LeadProjectGuard = (
  botId: string,
) => Array<{ id: string; title: string | null }> | null;

/** Bots CRUD. Deleted bots keep a placeholder row (id never reused). */
export class BotsService {
  /** D73：start.ts 在连接服务构造后接入；未接入时 `app_connection_ids` 只能为空。 */
  #connections: AppConnectionDirectory | null = null;
  /** D92 T1a：start.ts 在 projects 服务构造后接入。 */
  #leadProjectGuard: LeadProjectGuard | null = null;
  /** P2 注入模型：start.ts 在插件账本构造后接入；未接入时 `setPluginIds` 只能清空。 */
  #pluginDirectory: PluginDirectory | null = null;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
    private readonly defaultAgent: DefaultAgentResolver = () => null,
  ) {}

  /** D73：接入连接目录，`create` / `update` / `grantConnection` 据此校验授权。 */
  attachAppConnections(connections: AppConnectionDirectory): void {
    this.#connections = connections;
  }

  /** D92 T1a：接入负责人守卫（`markDeleted` 的后盾）。 */
  attachLeadProjectGuard(guard: LeadProjectGuard): void {
    this.#leadProjectGuard = guard;
  }

  /** P2 注入模型：接入插件目录（`PluginStore`），`setPluginIds` 校验 pluginIds 均已安装。 */
  attachPluginDirectory(directory: PluginDirectory): void {
    this.#pluginDirectory = directory;
  }

  /**
   * Profile 里的 `app_connection_ids` 校验（D73 §5.7）：每个 id 是存在（未删除）的目录连接
   * （自定义 server 的连接走 `mcp_server_ids`，不在此列），且同一 Connector 至多一个。
   * 违反 → `INVALID_INPUT`。
   */
  #assertAppConnections(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const directory = this.#connections;
    if (directory === null) {
      throw new AppError('INVALID_INPUT', '连接应用服务未就绪，不能授权连接');
    }
    const byConnector = new Map<string, string>();
    for (const id of ids) {
      const connection = id.startsWith('custom:') ? null : directory.get(id);
      if (connection === null) {
        throw new AppError('INVALID_INPUT', `连接 ${id} 不存在或已删除`, { connectionId: id });
      }
      const other = byConnector.get(connection.connectorId);
      if (other !== undefined && other !== id) {
        throw new AppError(
          'INVALID_INPUT',
          `同一个应用只能授权一个账号（${other} 与 ${id} 属于同一应用）`,
          { connectionIds: [other, id] },
        );
      }
      byConnector.set(connection.connectorId, id);
    }
  }

  /**
   * 授权连接给 Bot（连接流程完成后由 core 调用，`apps/connections.ts` 的 `BotAppGrantWriter`；渲染端
   * 不改 Profile）。幂等；同 Connector 已有另一个连接则替换它（返回被替换的连接 id）。Bot 不存在 /
   * 已删除、连接不存在 → 抛错。
   */
  grantConnection(botId: string, connectionId: string): { replaced: string[] } {
    const bot = this.getOrThrow(botId);
    if (bot.status !== 'active') {
      throw new AppError('CONVERSATION_READ_ONLY', `Bot ${botId} has been deleted`);
    }
    const directory = this.#connections;
    const connection = directory?.get(connectionId) ?? null;
    if (connection === null || connectionId.startsWith('custom:')) {
      throw new AppError('INVALID_INPUT', `连接 ${connectionId} 不存在或已删除`, { connectionId });
    }
    const current = bot.profile.runtime.app_connection_ids;
    const replaced = current.filter(
      (id) => id !== connectionId && directory?.get(id)?.connectorId === connection.connectorId,
    );
    if (current.includes(connectionId) && replaced.length === 0) return { replaced: [] };
    const next = [...current.filter((id) => !replaced.includes(id)), connectionId].filter(
      (id, index, all) => all.indexOf(id) === index,
    );
    this.#writeAppConnectionIds(bot, next);
    return { replaced };
  }

  /** 连接被删除：从所有 Bot 的授权里移除它。返回受影响的 Bot id（调用方据此中断其运行中的任务）。 */
  removeConnectionFromAll(connectionId: string): string[] {
    const affected: string[] = [];
    for (const bot of this.listAppConnectionHolders(connectionId)) {
      this.#writeAppConnectionIds(
        bot,
        bot.profile.runtime.app_connection_ids.filter((id) => id !== connectionId),
      );
      affected.push(bot.id);
    }
    return affected;
  }

  /** 授权了该连接的活跃 Bot（断开确认框列出受影响的 Bot）。 */
  listAppConnectionHolders(connectionId: string): Bot[] {
    return this.listActive().filter((bot) =>
      bot.profile.runtime.app_connection_ids.includes(connectionId),
    );
  }

  #writeAppConnectionIds(bot: Bot, ids: string[]): void {
    const profile = botProfileSchema.parse({
      ...bot.profile,
      runtime: { ...bot.profile.runtime, app_connection_ids: ids },
    });
    this.db
      .prepare('update bots set profile_json = ?, updated_at = ? where id = ?')
      .run(JSON.stringify(profile), this.clock.now(), bot.id);
  }

  /**
   * P2 注入模型：整体替换该 Bot 的插件启用集（`profile_json.runtime.plugin_ids`，
   * 沿 `#writeAppConnectionIds` 的 Profile-JSON 先例——只动这一个字段，其余 Profile
   * 保持不动）。pluginIds 去重后逐个校验已安装；缺失 / 空数组 = 未启用任何插件。
   */
  setPluginIds(botId: string, pluginIds: string[]): Bot {
    const bot = this.getOrThrow(botId);
    if (bot.status !== 'active') {
      throw new AppError('CONVERSATION_READ_ONLY', `Bot ${botId} has been deleted`);
    }
    const unique = [...new Set(pluginIds)];
    for (const pluginId of unique) {
      if (!this.#pluginDirectory?.installed(pluginId)) {
        throw new AppError('INVALID_INPUT', `插件 ${pluginId} 未安装，不能启用`);
      }
    }
    const profile = botProfileSchema.parse({
      ...bot.profile,
      runtime: { ...bot.profile.runtime, plugin_ids: unique },
    });
    this.db
      .prepare('update bots set profile_json = ?, updated_at = ? where id = ?')
      .run(JSON.stringify(profile), this.clock.now(), botId);
    return this.getOrThrow(botId);
  }

  create(
    profileInput: Partial<BotProfile> & { identity: { name: string } },
    options: {
      interview?: boolean;
      systemRole?: BotSystemRole;
      /**
       * D88：不套用 onboarding 的默认外部 Agent（移交「与来源相同」而来源本身就是空的
       * 模型 / Agent 时，新 Bot 要与来源一样跟随设置默认，而不是被换成外部 Agent）。
       */
      skipDefaultAgent?: boolean;
    } = {},
  ): Bot {
    const profile = stripLegacyInkcopTransport(botProfileSchema.parse(profileInput));
    this.#assertAppConnections(profile.runtime.app_connection_ids);
    // 未指定模型与 Agent 的新 Bot（对话式访谈除外：访谈只在内置引擎上跑）
    // 默认由 onboarding 选定的外部 Agent 驱动。
    if (
      options.interview !== true &&
      options.skipDefaultAgent !== true &&
      profile.runtime.model.length === 0 &&
      profile.runtime.agent.id.length === 0
    ) {
      const fallback = this.defaultAgent();
      if (fallback !== null) {
        profile.runtime.agent = {
          ...profile.runtime.agent,
          id: fallback.id,
          model: fallback.model,
          permission: fallback.permission,
        };
      }
    }
    const now = this.clock.now();
    const id = newId('bot');
    const setupState = options.interview === true ? BOT_SETUP_INTERVIEWING : null;
    const systemRole = options.systemRole ?? null;
    if (systemRole === 'butler' && this.getButler() !== null) {
      throw new AppError('ALREADY_EXISTS', '管家已存在，不能再创建第二个');
    }
    try {
      this.db
        .prepare(
          'insert into bots (id, name, avatar, bio, profile_json, status, setup_state, system_role, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          profile.identity.name.length > 0 ? profile.identity.name : BOT_SETUP_PLACEHOLDER_NAME,
          profile.identity.avatar ?? null,
          profile.identity.bio,
          JSON.stringify(profile),
          'active',
          setupState,
          systemRole,
          now,
          now,
        );
    } catch (error) {
      // bots_one_active_butler (0016) is the race backstop of the check above.
      if (systemRole === 'butler' && /UNIQUE constraint failed/i.test(String(error))) {
        throw new AppError('ALREADY_EXISTS', '管家已存在，不能再创建第二个');
      }
      throw error;
    }
    return this.getOrThrow(id);
  }

  /** The active butler (D70), or null before it has been ensured. */
  getButler(): Bot | null {
    const row = this.db
      .prepare("select * from bots where system_role = 'butler' and status = 'active'")
      .get() as BotRow | undefined;
    return row ? rowToBot(row) : null;
  }

  /**
   * Idempotently makes sure the single butler exists (D70). `interview`
   * starts it in the setup-interview state (new users: the butler interviews
   * and proposes a team); existing users get a plain butler. A concurrent
   * creator losing the unique-index race reads the winner back.
   */
  ensureButler(
    profile: Partial<BotProfile> & { identity: { name: string } },
    options: { interview?: boolean } = {},
  ): { bot: Bot; created: boolean } {
    const existing = this.getButler();
    if (existing !== null) return { bot: existing, created: false };
    try {
      return {
        bot: this.create(profile, {
          systemRole: 'butler',
          ...(options.interview === true ? { interview: true } : {}),
        }),
        created: true,
      };
    } catch (error) {
      const winner = this.getButler();
      if (winner !== null) return { bot: winner, created: false };
      throw error;
    }
  }

  /** Clears the setup-interview state without touching the name (butler interview exit, D70). */
  clearSetupState(id: string): Bot {
    this.db
      .prepare('update bots set setup_state = NULL, updated_at = ? where id = ?')
      .run(this.clock.now(), id);
    return this.getOrThrow(id);
  }

  get(id: string): Bot | null {
    const row = this.db.prepare('select * from bots where id = ?').get(id) as BotRow | undefined;
    return row ? rowToBot(row) : null;
  }

  getOrThrow(id: string): Bot {
    const bot = this.get(id);
    if (!bot) throw new AppError('NOT_FOUND', `Bot ${id} does not exist`);
    return bot;
  }

  /** Active bots (the address book); deleted placeholder rows are hidden. */
  listActive(): Bot[] {
    const rows = this.db
      .prepare("select * from bots where status = 'active' order by created_at")
      .all() as BotRow[];
    return rows.map(rowToBot);
  }

  update(id: string, profileInput: Partial<BotProfile> & { identity: { name: string } }): Bot {
    const existing = this.getOrThrow(id);
    if (existing.status !== 'active') {
      throw new AppError('CONVERSATION_READ_ONLY', `Bot ${id} has been deleted`);
    }
    const profile = stripLegacyInkcopTransport(botProfileSchema.parse(profileInput));
    this.#assertAppConnections(profile.runtime.app_connection_ids);
    this.db
      .prepare(
        'update bots set name = ?, avatar = ?, bio = ?, profile_json = ?, updated_at = ? where id = ?',
      )
      .run(
        profile.identity.name,
        profile.identity.avatar ?? null,
        profile.identity.bio,
        JSON.stringify(profile),
        this.clock.now(),
        id,
      );
    return this.getOrThrow(id);
  }

  /**
   * setup 工具直接落 profile（访谈期间免审批卡，见 setup-tools）。展示名
   * 保持创建时的占位（'新 Bot'）：访谈中途不改 bots.name，否则侧栏/顶部
   * 药丸会抖动甚至暴露空名（模型可能提交空 name）；profile_json 照常累计，
   * 名字随 finishSetup 一次性生效。
   */
  updateDuringSetup(id: string, profileInput: Partial<BotProfile>): Bot {
    const existing = this.getOrThrow(id);
    if (existing.status !== 'active') {
      throw new AppError('CONVERSATION_READ_ONLY', `Bot ${id} has been deleted`);
    }
    if (existing.setupState !== BOT_SETUP_INTERVIEWING) {
      throw new AppError('INVALID_INPUT', `Bot ${id} is not in setup interview`);
    }
    const merged = stripLegacyInkcopTransport(
      botProfileSchema.parse({
        ...existing.profile,
        ...profileInput,
      }),
    );
    this.db
      .prepare('update bots set avatar = ?, bio = ?, profile_json = ?, updated_at = ? where id = ?')
      .run(
        merged.identity.avatar ?? null,
        merged.identity.bio,
        JSON.stringify(merged),
        this.clock.now(),
        id,
      );
    return this.getOrThrow(id);
  }

  /** 结束初始化访谈（finish_setup 工具落点）：访谈期间攒下的名字在此生效。 */
  finishSetup(id: string): Bot {
    const existing = this.getOrThrow(id);
    if (existing.setupState !== BOT_SETUP_INTERVIEWING) return existing;
    const pendingName = existing.profile.identity.name.trim();
    const name = pendingName.length > 0 ? pendingName : existing.name;
    this.db
      .prepare('update bots set name = ?, setup_state = NULL, updated_at = ? where id = ?')
      .run(name, this.clock.now(), id);
    return this.getOrThrow(id);
  }

  /**
   * 头像槽位写入（avatars 服务落点）：只动 avatar 字段——访谈期间走此路径
   * （上传头像）不得像 update 那样把 profile 里攒下的真名提前写进 bots.name
   * （名字随 finishSetup 一次性生效，见 updateDuringSetup 注释）。
   */
  setAvatar(id: string, value: string | null): Bot {
    const existing = this.getOrThrow(id);
    if (existing.status !== 'active') {
      throw new AppError('CONVERSATION_READ_ONLY', `Bot ${id} has been deleted`);
    }
    const profile = botProfileSchema.parse({
      ...existing.profile,
      identity: { ...existing.profile.identity, avatar: value ?? undefined },
    });
    this.db
      .prepare('update bots set avatar = ?, profile_json = ?, updated_at = ? where id = ?')
      .run(value, JSON.stringify(profile), this.clock.now(), id);
    return this.getOrThrow(id);
  }

  /**
   * Turns the row into a placeholder: identity fields are cleared so the id
   * stays reserved for history rendering, but no profile survives.
   */
  markDeleted(id: string): void {
    const bot = this.getOrThrow(id);
    if (bot.systemRole === 'butler') {
      // Lifecycle rejects first (before any cascade); this is the backstop.
      throw new AppError('BOT_UNDELETABLE', '管家不能删除');
    }
    const ledProjects = this.#leadProjectGuard?.(id) ?? [];
    if (ledProjects.length > 0) {
      const names = ledProjects.map((project) => project.title ?? project.id).join('、');
      // Same backstop position as the butler guard (lifecycle rejects first).
      throw new AppError(
        'PROJECT_LEAD_REQUIRED',
        `该 Bot 是 ${ledProjects.length} 个项目组的负责人，请先更换：${names}`,
        { projects: ledProjects },
      );
    }
    const now = this.clock.now();
    this.db
      .prepare(
        "update bots set name = '', avatar = NULL, bio = '', profile_json = '{}', status = 'deleted', setup_state = NULL, updated_at = ?, deleted_at = ? where id = ?",
      )
      .run(now, now, id);
  }
}
