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
      browser_profile: '',
      agent: { ...BUILTIN_AGENT_RUNTIME },
    },
    behavior: { proactive: true, quiet_hours: null, max_proactive_per_day: null },
  };
}

function rowToBot(row: BotRow): Bot {
  const parsed = botProfileSchema.safeParse(JSON.parse(row.profile_json));
  const profile = parsed.success ? parsed.data : emptyProfile();
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
export type DefaultAgentResolver = () => { id: string; permission: AgentPermissionTier } | null;

/** Bots CRUD. Deleted bots keep a placeholder row (id never reused). */
export class BotsService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
    private readonly defaultAgent: DefaultAgentResolver = () => null,
  ) {}

  create(
    profileInput: Partial<BotProfile> & { identity: { name: string } },
    options: { interview?: boolean; systemRole?: BotSystemRole } = {},
  ): Bot {
    const profile = botProfileSchema.parse(profileInput);
    // 未指定模型与 Agent 的新 Bot（对话式访谈除外：访谈只在内置引擎上跑）
    // 默认由 onboarding 选定的外部 Agent 驱动。
    if (
      options.interview !== true &&
      profile.runtime.model.length === 0 &&
      profile.runtime.agent.id.length === 0
    ) {
      const fallback = this.defaultAgent();
      if (fallback !== null) {
        profile.runtime.agent = {
          ...profile.runtime.agent,
          id: fallback.id,
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
    const profile = botProfileSchema.parse(profileInput);
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
    const merged = botProfileSchema.parse({
      ...existing.profile,
      ...profileInput,
    });
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
    const now = this.clock.now();
    this.db
      .prepare(
        "update bots set name = '', avatar = NULL, bio = '', profile_json = '{}', status = 'deleted', setup_state = NULL, updated_at = ?, deleted_at = ? where id = ?",
      )
      .run(now, now, id);
  }
}
