import {
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 账号密码认证（D102 修订：直连模式默认）：管理员账号在 headless 首启时建立
 * （交互式提示或 --admin-user/--admin-password，systemd 用环境变量），凭据记忆
 * 在用户脑子里——任何设备打开网址登录即可，无需再到服务端取配对码。
 *
 * 存储：`<data-dir>/auth.json`（0600）存用户名 + scrypt 哈希 + 密码版本号；
 * `<data-dir>/session-secret`（0600）是会话 token 的 HMAC 签名密钥。token 无状态
 * （`v1.<payload>.<hmac>`，payload = 用户名/密码版本/过期时间）——服务重启不掉线，
 * 改密码即全量失效（版本号不匹配）。配对模式的 E2E 设备凭证（D96）不受影响。
 */

/** OWASP 建议 scrypt N ≥ 2^17（审查修复：原 2^14 离线爆破成本偏低）。 */
const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1, keylen: 64 };
type ScryptParams = { N: number; r: number; p: number };
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Cookie Max-Age 用秒——与 token 的 SESSION_TTL_MS 同源（审查 P3：原先两处字面量会漂移）。 */
export const SESSION_TTL_SEC = SESSION_TTL_MS / 1000;
export const SESSION_COOKIE = 'kepcup_session';
/** 密码最小长度：与「拿到地址的人不能直接用」的门槛匹配，弱口令靠限流与 TLS 兜底。 */
export const MIN_PASSWORD_LENGTH = 8;

/** 异步版（审查 P3：scryptSync 在 libuv 线程上跑会阻塞事件循环 ~0.5s，登录并发时雪上加霜）。 */
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

export interface StoredAdmin {
  username: string;
  saltB64: string;
  hashB64: string;
  /** 哈希参数随档存储：校验按建档参数执行；缺省（旧档）按当前参数（会失配 → 重新建号）。 */
  params?: ScryptParams;
  /** 改密码 +1：旧会话 token 全部失效。 */
  passwordVersion: number;
  createdAt: number;
  updatedAt: number;
}

export class AuthError extends Error {
  constructor(
    readonly code: 'INVALID_CREDENTIALS' | 'WEAK_PASSWORD' | 'RATE_LIMITED' | 'NOT_CONFIGURED',
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function writeJson0600(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export async function hashPassword(
  password: string,
  salt: Buffer,
  params: ScryptParams = SCRYPT_PARAMS,
): Promise<Buffer> {
  return Buffer.from(
    await scryptAsync(password.normalize('NFKC'), salt, SCRYPT_PARAMS.keylen, {
      N: params.N,
      r: params.r,
      p: params.p,
      // OpenSSL 默认 scrypt 内存上限 32MB；N=2^17·r=8 需 ~128MB（128·N·r）。
      maxmem: 256 * 1024 * 1024,
    }),
  );
}

export function validatePasswordStrength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError('WEAK_PASSWORD', `密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
}

/** 管理员账号存储 + 会话 token 签发校验。 */
export class AuthStore {
  readonly #authFile: string;
  readonly #secretFile: string;
  #admin: StoredAdmin | null;
  readonly #secret: Buffer;
  readonly #limiter = new LoginRateLimiter();

  constructor(dataDir: string) {
    this.#authFile = path.join(dataDir, 'auth.json');
    this.#secretFile = path.join(dataDir, 'session-secret');
    this.#admin = readJson<StoredAdmin>(this.#authFile);
    if (this.#admin !== null && !this.#validateShape(this.#admin)) {
      throw new AuthError('NOT_CONFIGURED', `${this.#authFile} 结构不合法，请删除后重新初始化`);
    }
    const existing = existsSync(this.#secretFile)
      ? Buffer.from(readFileSync(this.#secretFile, 'utf8').trim(), 'base64')
      : null;
    if (existing !== null && existing.length >= 32) {
      this.#secret = existing;
    } else {
      this.#secret = randomBytes(32);
      writeFileSync(this.#secretFile, `${this.#secret.toString('base64')}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
  }

  #validateShape(admin: StoredAdmin): boolean {
    return (
      typeof admin.username === 'string' &&
      admin.username.length > 0 &&
      admin.username.length <= 60 &&
      typeof admin.saltB64 === 'string' &&
      typeof admin.hashB64 === 'string' &&
      typeof admin.passwordVersion === 'number' &&
      Number.isFinite(admin.passwordVersion)
    );
  }

  isConfigured(): boolean {
    return this.#admin !== null;
  }

  get username(): string | null {
    return this.#admin?.username ?? null;
  }

  /** 首启建号（已存在则拒绝——改密走 changePassword）。 */
  async setupAdmin(username: string, password: string): Promise<void> {
    if (this.#admin !== null) throw new AuthError('NOT_CONFIGURED', '管理员账号已存在（改密码用 kepcup-server password）');
    validatePasswordStrength(password);
    const salt = randomBytes(16);
    const admin: StoredAdmin = {
      username,
      saltB64: salt.toString('base64'),
      hashB64: (await hashPassword(password, salt)).toString('base64'),
      params: { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p },
      passwordVersion: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    writeJson0600(this.#authFile, admin);
    this.#admin = admin;
  }

  /** 改密码（校验旧密码）：版本号 +1，全部旧会话失效。 */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    const admin = this.#requireAdmin();
    if (!(await this.#verifyHash(admin, oldPassword))) {
      throw new AuthError('INVALID_CREDENTIALS', '旧密码不正确');
    }
    validatePasswordStrength(newPassword);
    const salt = randomBytes(16);
    const next: StoredAdmin = {
      ...admin,
      saltB64: salt.toString('base64'),
      hashB64: (await hashPassword(newPassword, salt)).toString('base64'),
      params: { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p },
      passwordVersion: admin.passwordVersion + 1,
      updatedAt: Date.now(),
    };
    writeJson0600(this.#authFile, next);
    this.#admin = next;
  }

  #requireAdmin(): StoredAdmin {
    if (this.#admin === null) {
      throw new AuthError('NOT_CONFIGURED', '管理员账号未初始化（先完成 headless 首启建号）');
    }
    return this.#admin;
  }

  async #verifyHash(admin: StoredAdmin, password: string): Promise<boolean> {
    const stored = Buffer.from(admin.hashB64, 'base64');
    const actual = await hashPassword(
      password,
      Buffer.from(admin.saltB64, 'base64'),
      admin.params,
    );
    return stored.length === actual.length && timingSafeEqual(stored, actual);
  }

  /**
   * 登录校验（带每 IP 限流）。成功返回会话 token；失败统一报 INVALID_CREDENTIALS
   *（不区分用户名错还是密码错）。
   */
  async login(username: string, password: string, clientIp: string): Promise<string> {
    const admin = this.#requireAdmin();
    this.#limiter.check(clientIp);
    if (username !== admin.username || !(await this.#verifyHash(admin, password))) {
      // 用户名错误也跑一次同代价哈希，抹平计时差（单账号枚举面很小，顺手闭环）。
      if (username !== admin.username) {
        await hashPassword(password, Buffer.from(admin.saltB64, 'base64'), admin.params);
      }
      throw this.#limiter.fail(clientIp);
    }
    this.#limiter.reset(clientIp);
    return this.issueToken();
  }

  issueToken(): string {
    const admin = this.#requireAdmin();
    const payload = Buffer.from(
      JSON.stringify({
        u: admin.username,
        v: admin.passwordVersion,
        exp: Date.now() + SESSION_TTL_MS,
      }),
      'utf8',
    ).toString('base64url');
    const sig = createHmac('sha256', this.#secret).update(payload).digest('base64url');
    return `v1.${payload}.${sig}`;
  }

  /** 校验会话 token：签名 + 过期 + 密码版本三者都要过。 */
  verifyToken(token: string | undefined): { username: string } | null {
    if (token === undefined || !token.startsWith('v1.')) return null;
    const [version, payload, sig] = token.split('.');
    if (version !== 'v1' || payload === undefined || sig === undefined) return null;
    const expected = createHmac('sha256', this.#secret).update(payload).digest();
    const actual = Buffer.from(sig, 'base64url');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    let claims: { u?: unknown; v?: unknown; exp?: unknown };
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    const admin = this.#admin;
    if (
      admin === null ||
      claims.u !== admin.username ||
      claims.v !== admin.passwordVersion ||
      typeof claims.exp !== 'number' ||
      claims.exp < Date.now()
    ) {
      return null;
    }
    return { username: admin.username };
  }
}

/**
 * 每 IP 失败计数：窗口内失败过多暂时拒绝（成功登录清零）。键做 IPv6 前缀归一
 *（旋转地址绕不开限流）；过期窗口在表增长到阈值时顺路清扫（反代共享 IP / 地址
 * 喷射下 Map 不无界增长）。
 */
export class LoginRateLimiter {
  readonly #windowMs = 15 * 60 * 1000;
  readonly #maxFailures = 10;
  /** 超过该条目数触发一次过期清扫（摊销：正常规模永远到不了）。 */
  readonly #pruneThreshold = 256;
  readonly #failures = new Map<string, { count: number; windowStart: number }>();

  check(ip: string): void {
    const entry = this.#entry(ip);
    if (entry.count >= this.#maxFailures) {
      const retryAfterMs = entry.windowStart + this.#windowMs - Date.now();
      throw new AuthError(
        'RATE_LIMITED',
        '登录失败次数过多，稍后再试',
        Math.max(1, Math.ceil(retryAfterMs / 1000)),
      );
    }
  }

  fail(ip: string): AuthError {
    const entry = this.#entry(ip);
    entry.count += 1;
    return new AuthError('INVALID_CREDENTIALS', '用户名或密码不正确');
  }

  reset(ip: string): void {
    this.#failures.delete(limitKey(ip));
  }

  #entry(ip: string): { count: number; windowStart: number } {
    const now = Date.now();
    if (this.#failures.size > this.#pruneThreshold) this.#prune(now);
    const key = limitKey(ip);
    const existing = this.#failures.get(key);
    if (existing === undefined || now - existing.windowStart >= this.#windowMs) {
      const fresh = { count: 0, windowStart: now };
      this.#failures.set(key, fresh);
      return fresh;
    }
    return existing;
  }

  #prune(now: number): void {
    for (const [key, entry] of this.#failures) {
      if (now - entry.windowStart >= this.#windowMs) this.#failures.delete(key);
    }
  }
}

/**
 * 限流键归一（审查后议）：`::ffff:x.x.x.x` 还原 IPv4；IPv6 取前 4 组（≈/64，
 * ISP/移动网络给单设备分配的最小块）聚合——攻击者在同 /64 内旋转 /128 绕不开。
 * 压缩表示（`::`）组数不足 4 时保守取整体：限流宁可偏严。
 */
function limitKey(ip: string): string {
  let key = ip;
  if (key.startsWith('::ffff:')) key = key.slice(7);
  if (key.includes(':')) {
    const groups = key.split(':');
    if (groups.length >= 4) key = groups.slice(0, 4).join(':');
  }
  return key;
}

/** 从 Cookie 头取会话 token。 */
export function sessionTokenFromCookie(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return undefined;
}
