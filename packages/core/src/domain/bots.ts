import { AppError, botProfileSchema, newId, type Bot, type BotProfile } from '@kepcup/shared';
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
    runtime: { model: '', light_model: '', network_policy: 'open', network_allowlist: [] },
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Bots CRUD. Deleted bots keep a placeholder row (id never reused). */
export class BotsService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  create(
    profileInput: Partial<BotProfile> & { identity: { name: string } },
    options: { interview?: boolean } = {},
  ): Bot {
    const profile = botProfileSchema.parse(profileInput);
    const now = this.clock.now();
    const id = newId('bot');
    const setupState = options.interview === true ? BOT_SETUP_INTERVIEWING : null;
    this.db
      .prepare(
        'insert into bots (id, name, avatar, bio, profile_json, status, setup_state, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        profile.identity.name.length > 0 ? profile.identity.name : BOT_SETUP_PLACEHOLDER_NAME,
        profile.identity.avatar ?? null,
        profile.identity.bio,
        JSON.stringify(profile),
        'active',
        setupState,
        now,
        now,
      );
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
    this.getOrThrow(id);
    const now = this.clock.now();
    this.db
      .prepare(
        "update bots set name = '', avatar = NULL, bio = '', profile_json = '{}', status = 'deleted', setup_state = NULL, updated_at = ?, deleted_at = ? where id = ?",
      )
      .run(now, now, id);
  }
}
