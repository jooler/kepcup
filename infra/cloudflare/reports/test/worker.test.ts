/**
 * Public pipeline tests (todo/ai-content-reporting.md §10.2): routing, media type,
 * body cap, validation, hash verification, idempotency, dedupe windows, the
 * dedupe-before-rate-limit ordering, IP limiting, response headers (no CORS),
 * logs, and the cron cleanup.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCleanup, bumpDailyCount } from '../src/db';
import { utcDayOf } from '../src/dedupe';
import {
  hmacSha256Hex,
  MAX_BODY_BYTES,
  parseConfig,
  readBodyWithLimit,
  splitModelRef,
} from '../src/worker';
import type { D1Like, Env, ReportPayload, ReportSource } from '../src/types';
import {
  decodeChallengeToken,
  ipHashOf,
  makeProof,
  NOW,
  bearer,
  cloneFixture,
  finalize,
  get,
  loadFixture,
  makeDeps,
  makeVariant,
  post,
  postReport,
  seedDaily,
  seedIpRate,
  seedPowUsed,
  seedRate,
  seedReport,
  send,
  solvePow,
  solvePowExactBits,
  type Res,
  type TestRig,
} from './helpers';

let rig: TestRig;
let logs: string[];

beforeEach(() => {
  rig = makeDeps();
  // 收集（并静音）worker 的 JSON 日志；日志断言在专门的 describe 里。
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Mutate the fixture into an invalid payload and POST it; returns issues. */
async function postBad(mutate: (p: ReportPayload) => void): Promise<Res> {
  const payload = cloneFixture();
  mutate(payload);
  return post(rig.deps, '/v1/reports', payload);
}

describe('routing', () => {
  it('GET /healthz reports ok + build version', async () => {
    const { res, body } = await get(rig.deps, '/healthz');
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, version: 'test-1.0.0' });
  });

  it('POST /v1/reports accepts a valid report', async () => {
    const { res, body } = await postReport(rig.deps, cloneFixture());
    expect(res.status).toBe(201);
    expect(body).toEqual({ status: 'accepted', id: loadFixture().reportId });
  });

  it('wrong methods on known paths are 405 with Allow', async () => {
    for (const [path, method] of [
      ['/v1/reports', 'GET'],
      ['/v1/reports', 'PUT'],
      ['/healthz', 'POST'],
      ['/healthz', 'DELETE'],
      ['/v1/reports', 'OPTIONS'],
    ] as const) {
      const { res, body } = await send(rig.deps, path, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe(path === '/healthz' ? 'GET' : 'POST');
      expect(body).toEqual({ error: 'method_not_allowed' });
    }
  });

  it('unknown paths are a JSON 404', async () => {
    for (const path of ['/', '/v1/nope', '/v1/reports/extra', '/healthzx']) {
      const { res, body } = await get(rig.deps, path);
      expect(res.status).toBe(404);
      expect(body).toEqual({ error: 'not_found' });
    }
  });
});

describe('media type and body cap', () => {
  it('non-JSON content type is 415', async () => {
    const { res, body } = await post(rig.deps, '/v1/reports', '{}', {
      'content-type': 'text/plain',
    });
    expect(res.status).toBe(415);
    expect(body).toEqual({ error: 'unsupported_media_type' });
  });

  it('tolerates content-type parameters', async () => {
    const { res } = await post(rig.deps, '/v1/reports', '{}', {
      'content-type': 'application/json; charset=utf-8',
    });
    // valid headers but empty payload -> validation 400, NOT 415
    expect(res.status).toBe(400);
  });

  it('bodies over 128 KiB are 413 before parsing', async () => {
    const oversized = `{"a":"${'x'.repeat(MAX_BODY_BYTES + 10_000)}"}`;
    const { res, body } = await post(rig.deps, '/v1/reports', oversized);
    expect(res.status).toBe(413);
    expect(body).toEqual({ error: 'payload_too_large' });
  });

  it('readBodyWithLimit counts streamed bytes, not Content-Length', async () => {
    const encoder = new TextEncoder();
    const streamOf = (chunks: Uint8Array[]) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
    // Three 60 KiB chunks = 180 KiB > 128 KiB cap even if a header claimed less.
    const big = streamOf([
      new Uint8Array(60_000).fill(97),
      new Uint8Array(60_000).fill(97),
      new Uint8Array(60_000).fill(97),
    ]);
    expect(await readBodyWithLimit(big.getReader(), MAX_BODY_BYTES)).toBeNull();
    const small = streamOf([encoder.encode('{"a":1}')]);
    expect(await readBodyWithLimit(small.getReader(), MAX_BODY_BYTES)).toBe('{"a":1}');
    expect(await readBodyWithLimit(null, MAX_BODY_BYTES)).toBe('');
  });

  it('malformed JSON is 400', async () => {
    const { res, body } = await post(rig.deps, '/v1/reports', '{"a":');
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: 'bad_json' });
  });

  it('invalid UTF-8 bodies are 400 (fatal decode)', async () => {
    const { res, body } = await send(rig.deps, '/v1/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
    });
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: 'bad_json' });
  });
});

describe('validation (§7.4 step 5)', () => {
  it('accepts the untouched fixture', async () => {
    const { res } = await postReport(rig.deps, cloneFixture());
    expect(res.status).toBe(201);
  });

  it.each([
    ['schemaVersion wrong', (p: ReportPayload) => void (p.schemaVersion = 2), 'schemaVersion'],
    ['reportId without prefix', (p: ReportPayload) => void (p.reportId = 'abc_123'), 'reportId'],
    [
      'reportId too long',
      (p: ReportPayload) => void (p.reportId = `rep_${'x'.repeat(70)}`),
      'reportId',
    ],
    ['createdAt zero', (p: ReportPayload) => void (p.createdAt = 0), 'createdAt'],
    ['unknown reason', (p: ReportPayload) => void (p.reason = 'spam'), 'reason'],
    ['client missing', (p: ReportPayload) => void ((p as unknown as Record<string, unknown>).client = undefined), 'client'],
    ['empty client id', (p: ReportPayload) => void (p.client.id = ''), 'client.id'],
    [
      'bad source kind',
      (p: ReportPayload) => void (p.source = { kind: 'web' } as unknown as ReportSource),
      'source.kind',
    ],
    [
      'team without serverHash',
      (p: ReportPayload) => void (p.source = { kind: 'team', serverHash: '' }),
      'serverHash',
    ],
    [
      'bad conversation type',
      (p: ReportPayload) => void (p.conversation.type = 'group'),
      'conversation.type',
    ],
    [
      'bad message kind',
      (p: ReportPayload) => void (p.message.kind = 'image' as 'text' | 'card'),
      'message.kind',
    ],
    [
      'text and content both empty',
      (p: ReportPayload) => {
        p.message.text = '';
        p.message.content = null;
      },
      'at least one of text or content',
    ],
    [
      'text over 32 KiB',
      (p: ReportPayload) => void (p.message.text = 'a'.repeat(33_000)),
      'message.text',
    ],
    [
      'too many attachments',
      (p: ReportPayload) => {
        p.message.attachments = Array.from({ length: 21 }, (_, i) => ({
          fileName: `f${i}.png`,
          mime: 'image/png',
          size: 1,
        }));
      },
      'attachments',
    ],
    [
      'negative attachment size',
      (p: ReportPayload) => void (p.message.attachments[0]!.size = -1),
      'attachments[].size',
    ],
    [
      'too much context',
      (p: ReportPayload) => {
        p.context = Array.from({ length: 5 }, (_, i) => ({
          messageId: `m${i}`,
          senderType: 'user',
          kind: 'text',
          text: 't',
          createdAt: NOW,
        }));
      },
      'context',
    ],
    [
      'too many usage rows',
      (p: ReportPayload) => {
        p.usage = Array.from({ length: 17 }, () => ({
          provider: 'openai',
          model: 'gpt',
          loopType: 'turn',
          calls: 1,
          inputTokens: 1,
          outputTokens: 1,
        }));
      },
      'usage',
    ],
    [
      'too many tools',
      (p: ReportPayload) => {
        p.tools = Array.from({ length: 33 }, () => ({ name: 't', calls: 1 }));
      },
      'tools',
    ],
    [
      'too many providers',
      (p: ReportPayload) => {
        p.providers = Array.from({ length: 17 }, () => ({
          id: 'p',
          name: 'P',
          vendor: 'v',
          api: 'a',
        }));
      },
      'providers',
    ],
    [
      'uppercase hash',
      (p: ReportPayload) => void (p.hashes.content = p.hashes.content.toUpperCase()),
      'hashes.content',
    ],
    [
      'control character in text',
      (p: ReportPayload) => void (p.message.text = 'bad\u0000char'),
      'control characters',
    ],
    [
      'replyTo.text over 2 KiB',
      (p: ReportPayload) => void (p.replyTo = { messageId: 'm', text: 'x'.repeat(3000) }),
      'replyTo.text',
    ],
    [
      'bot.profile over 8 KiB',
      (p: ReportPayload) => void (p.bot.profile = { blob: 'x'.repeat(9000) }),
      'bot.profile',
    ],
    [
      'system prompt uploaded as string over cap',
      (p: ReportPayload) => void (p.bot.systemRole = 's'.repeat(3000)),
      'bot.systemRole',
    ],
  ])('%s -> 400 with an issue', async (_name, mutate, issueFragment) => {
    const { res, body } = await postBad(mutate);
    expect(res.status).toBe(400);
    const issues = (body as { issues?: string[] }).issues ?? [];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.includes(issueFragment))).toBe(true);
  });

  it('issues never echo the offending value', async () => {
    const longText = 'a'.repeat(33_000);
    const { body } = await postBad((p) => void (p.message.text = longText));
    const joined = JSON.stringify(body);
    expect(joined).not.toContain(longText);
    expect(joined).not.toContain(loadFixture().client.id);
  });

  it('excessive nesting is a 400 at validation (not a 500 from the hash pass)', async () => {
    // 65+ 层嵌套（dedupe.ts canonicalJson 的 RangeError 阈值之上）：校验必须先以
    // 400 拒绝，而不是等重算 hash 时炸成 500。
    let deep: unknown = 'x';
    for (let i = 0; i < 80; i += 1) deep = [deep];
    const payload = cloneFixture();
    payload.message.kind = 'card';
    (payload.message as unknown as { content: unknown }).content = deep;
    const { res, body } = await post(rig.deps, '/v1/reports', payload);
    expect(res.status).toBe(400);
    const issues = (body as { issues?: string[] }).issues ?? [];
    expect(issues.some((issue) => issue.includes('nesting'))).toBe(true);
  });

  it('a DEL (0x7F) control character is rejected like the other C0 chars', async () => {
    const { res, body } = await postBad((p) => void (p.message.text = 'bad\u007Fchar'));
    expect(res.status).toBe(400);
    const issues = (body as { issues?: string[] }).issues ?? [];
    expect(issues.some((issue) => issue.includes('control characters'))).toBe(true);
  });
});

describe('hash verification (§7.4 step 6)', () => {
  it('a lying content hash is a 400', async () => {
    const payload = await finalize(cloneFixture());
    payload.hashes.content = 'a'.repeat(64);
    const { res, body } = await postReport(rig.deps, payload);
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: 'hash_mismatch' });
  });

  it('a lying payload hash is a 400', async () => {
    const payload = await finalize(cloneFixture());
    payload.hashes.payload = 'b'.repeat(64);
    const { res } = await postReport(rig.deps, payload);
    expect(res.status).toBe(400);
  });

  it('mutating content after finalize is caught', async () => {
    const payload = await finalize(cloneFixture());
    payload.message.text = `${payload.message.text}（篡改）`;
    const { res } = await postReport(rig.deps, payload);
    expect(res.status).toBe(400);
  });
});

describe('idempotency and dedupe (§7.4 steps 7-8)', () => {
  it('the same reportId answers duplicate without re-storing', async () => {
    expect((await postReport(rig.deps, cloneFixture())).res.status).toBe(201);
    const retry = await postReport(rig.deps, cloneFixture());
    expect(retry.res.status).toBe(200);
    expect(retry.body).toEqual({ status: 'duplicate', reason: 'report_id' });

    // Same id but DIFFERENT content still short-circuits on the id (step 7 first).
    const mutated = cloneFixture();
    mutated.reportId = loadFixture().reportId;
    mutated.message.text = `${mutated.message.text}（改）`;
    const other = await postReport(rig.deps, await finalize(mutated));
    expect(other.body).toEqual({ status: 'duplicate', reason: 'report_id' });
    expect(rig.d1.rows('SELECT COUNT(*) AS n FROM reports')[0]).toEqual({ n: 1 });
  });

  it('same content in the same bucket is a content duplicate', async () => {
    expect((await postReport(rig.deps, cloneFixture())).res.status).toBe(201);
    // New click: new reportId/createdAt (both stripped from the payload hash), same text.
    const again = await postReport(rig.deps, await finalize(makeVariant(cloneFixture(), { keepText: true })));
    expect(again.res.status).toBe(200);
    expect(again.body).toEqual({ status: 'duplicate', reason: 'content' });
  });

  it('payload-hash dedupe survives a content-bucket rollover', async () => {
    expect((await postReport(rig.deps, cloneFixture())).res.status).toBe(201);
    rig.advance(24 * 3600_000 + 1); // content bucket rotates, payload bucket (90d) holds
    const again = await postReport(rig.deps, await finalize(makeVariant(cloneFixture(), { keepText: true })));
    expect(again.res.status).toBe(200);
    expect(again.body).toEqual({ status: 'duplicate', reason: 'payload' });
  });

  it('after both buckets roll over the same text is accepted again', async () => {
    expect((await postReport(rig.deps, cloneFixture())).res.status).toBe(201);
    rig.advance(91 * 24 * 3600_000);
    const again = await postReport(rig.deps, await finalize(makeVariant(cloneFixture(), { keepText: true })));
    expect(again.res.status).toBe(201);
  });

  it('dedupe is per client: another client reporting the same text is accepted', async () => {
    expect((await postReport(rig.deps, cloneFixture())).res.status).toBe(201);
    const other = await postReport(
      rig.deps,
      await finalize(makeVariant(cloneFixture(), { clientId: 'client-other', keepText: true })),
    );
    expect(other.res.status).toBe(201);
  });

  it('a team snapshot with conversation.type "dm" is accepted (shared enum parity)', async () => {
    // 契约缺口 (a)：团队快照带 conversation.type（conversationTypeSchema 全枚举）
    // 时，Worker 的 CONVERSATION_TYPES 必须照单全收 —— 否则合法 team 举报会被 400。
    const team = cloneFixture();
    team.source = { kind: 'team', serverHash: 'a'.repeat(16) };
    team.conversation = { id: 'srv_conv_1', type: 'dm' };
    const { res, body } = await postReport(rig.deps, await finalize(team));
    expect(res.status).toBe(201);
    expect((body as { status: string }).status).toBe('accepted');
    const row = rig.d1.rows<{ source_kind: string }>('SELECT source_kind FROM reports')[0]!;
    expect(row.source_kind).toBe('team');
  });

  it('INSERT OR IGNORE is the concurrency backstop (changes=0 on unique hit)', async () => {
    const { insertReport } = await import('../src/db');
    const payload = cloneFixture();
    const row = {
      id: payload.reportId,
      clientId: payload.client.id,
      contentHash: 'c',
      contentBucket: 0,
      payloadHash: 'p',
      payloadBucket: 0,
      botId: null,
      botName: null,
      modelProvider: null,
      modelId: null,
      messageKind: 'text',
      messageText: 't',
      appVersion: null,
      platform: null,
      sourceKind: 'local',
      receivedAt: NOW,
      ipHash: null,
      payloadJson: '{}',
    };
    expect(await insertReport(rig.deps.db, row)).toBe(1);
    // Same content tuple under a DIFFERENT id (what a concurrent duplicate insert looks like).
    expect(await insertReport(rig.deps.db, { ...row, id: 'rep_CONCURRENT' })).toBe(0);
    // ...and the same id again (payload unique).
    expect(await insertReport(rig.deps.db, row)).toBe(0);
  });
});

describe('client rate limit and ordering (dedupe before rate limit)', () => {
  it('duplicate clicks never consume the 1/min slot', async () => {
    expect((await postReport(rig.deps, cloneFixture())).res.status).toBe(201);
    // Same payload, new id: duplicate (neither report_id nor rate limit).
    const dup = await postReport(rig.deps, await finalize(makeVariant(cloneFixture(), { keepText: true })));
    expect(dup.res.status).toBe(200);
    expect(dup.body).toEqual({ status: 'duplicate', reason: 'content' });
    // The first accept consumed the 1/min slot, so genuinely NEW content within the
    // window must be throttled — proving the duplicate above did not consume/reset it.
    const throttled = await postReport(rig.deps, await finalize(makeVariant(cloneFixture())));
    expect(throttled.res.status).toBe(429);
    const body = throttled.body as { error: string; retryAfterMs: number };
    expect(body.error).toBe('rate_limited');
    expect(body.retryAfterMs).toBeGreaterThan(0);
    expect(body.retryAfterMs).toBeLessThanOrEqual(60_000);
    expect(throttled.res.headers.get('retry-after')).toBe(
      String(Math.ceil(body.retryAfterMs / 1000)),
    );
  });

  it('after the window the next distinct report is accepted', async () => {
    expect((await postReport(rig.deps, cloneFixture())).res.status).toBe(201);
    rig.advance(61_000);
    const next = await postReport(rig.deps, await finalize(makeVariant(cloneFixture())));
    expect(next.res.status).toBe(201);
    expect((next.body as { status: string; id: string }).status).toBe('accepted');
    expect(String((next.body as { id: string }).id)).toMatch(/^rep_/);
  });

  it('rate rows are per client', async () => {
    expect((await postReport(rig.deps, cloneFixture())).res.status).toBe(201);
    const other = await postReport(
      rig.deps,
      await finalize(makeVariant(cloneFixture(), { clientId: 'client-b' })),
    );
    expect(other.res.status).toBe(201);
  });
});

describe('IP rate limit (HMAC, 100/hour)', () => {
  const IP = '203.0.113.9';
  const SALT = 'test-ip-salt';

  function ipRig(): TestRig {
    return makeDeps({ config: { ipHashSalt: SALT, rateLimitMs: 0 } });
  }

  it('default 100/hour: the 101st distinct report from one IP is throttled', async () => {
    const deps = ipRig();
    for (let i = 0; i < 100; i++) {
      const payload = await finalize(makeVariant(cloneFixture(), { clientId: `client-${i}` }));
      const { res } = await postReport(deps.deps, payload, { ip: IP });
      expect(res.status).toBe(201);
    }
    const over = await postReport(
      deps.deps,
      await finalize(makeVariant(cloneFixture(), { clientId: 'client-over' })),
      { ip: IP },
    );
    expect(over.res.status).toBe(429);
    const body = over.body as { error: string; retryAfterMs: number };
    expect(body.error).toBe('rate_limited');
    expect(body.retryAfterMs).toBeGreaterThan(0);
    expect(body.retryAfterMs).toBeLessThanOrEqual(3_600_000);

    // Only the HMAC digest is stored, never the raw IP.
    const rows = deps.d1.rows<{ ip_hash: string; count: number }>(
      'SELECT ip_hash, count FROM report_ip_rate',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ip_hash).not.toContain(IP);
    expect(rows[0]!.ip_hash).toBe(await hmacSha256Hex(SALT, IP));
    expect(rows[0]!.count).toBe(101); // the rejected request still consumed its window slot
  });

  it('window rollover un-throttles the IP', async () => {
    const deps = ipRig();
    for (let i = 0; i < 100; i++) {
      const payload = await finalize(makeVariant(cloneFixture(), { clientId: `client-${i}` }));
      await postReport(deps.deps, payload, { ip: IP });
    }
    deps.advance(3_600_000 + 1);
    const after = await postReport(
      deps.deps,
      await finalize(makeVariant(cloneFixture(), { clientId: 'client-after' })),
      { ip: IP },
    );
    expect(after.res.status).toBe(201);
    const rows = deps.d1.rows<{ window_start: number; count: number }>(
      'SELECT window_start, count FROM report_ip_rate',
    );
    expect(rows).toHaveLength(1); // rotated in place
    expect(rows[0]!.count).toBe(1);
  });

  it('no salt configured -> IP limiting is skipped entirely', async () => {
    const deps = makeDeps({ config: { rateLimitMs: 0 } });
    for (let i = 0; i < 5; i++) {
      const payload = await finalize(makeVariant(cloneFixture(), { clientId: `client-${i}` }));
      const { res } = await postReport(deps.deps, payload, { ip: IP });
      expect(res.status).toBe(201);
    }
    expect(deps.d1.rows('SELECT * FROM report_ip_rate')).toHaveLength(0);
  });

  it('no CF-Connecting-IP header -> skipped even with a salt', async () => {
    const deps = ipRig();
    const { res } = await postReport(deps.deps, cloneFixture());
    expect(res.status).toBe(201);
    expect(deps.d1.rows('SELECT * FROM report_ip_rate')).toHaveLength(0);
    const row = deps.d1.rows<{ ip_hash: string | null }>('SELECT ip_hash FROM reports')[0];
    expect(row?.ip_hash).toBeNull();
  });
});

// ------------------------------------------------------------------ PoW + daily cap (task 5A)

/** PoW 启用的 rig：难度 8（低难度快速求解），限流关闭以便连续提交。 */
function powRig(overrides: Partial<TestRig['deps']['config']> = {}): TestRig {
  return makeDeps({ config: { powDifficulty: 8, rateLimitMs: 0, ...overrides } });
}

describe('parseConfig PoW escape hatches (task 5A)', () => {
  /** 逃生开关矩阵：difficulty=0 或 REPORT_POW_SECRET 未配/空串 => PoW 不强制。 */
  function envOf(partial: Partial<Env>): Env {
    return { DB: {} as D1Like, ...partial };
  }

  it('difficulty>0 + secret set -> enforced', () => {
    const config = parseConfig(envOf({ REPORT_POW_DIFFICULTY: '20', REPORT_POW_SECRET: 'ab'.repeat(32) }));
    expect(config.powEnabled).toBe(true);
    expect(config.powDifficulty).toBe(20);
    expect(config.powTtlMs).toBe(600_000);
    expect(config.dailyLimit).toBe(2000);
  });

  it('difficulty=0 -> not enforced (even with a secret)', () => {
    expect(
      parseConfig(envOf({ REPORT_POW_DIFFICULTY: '0', REPORT_POW_SECRET: 'ab'.repeat(32) }))
        .powEnabled,
    ).toBe(false);
  });

  it('secret unset or empty -> not enforced (even with difficulty>0)', () => {
    expect(parseConfig(envOf({ REPORT_POW_DIFFICULTY: '20' })).powEnabled).toBe(false);
    expect(parseConfig(envOf({ REPORT_POW_DIFFICULTY: '20', REPORT_POW_SECRET: '' })).powEnabled).toBe(false);
  });

  it('bad numeric vars fall back to the defaults', () => {
    const config = parseConfig(
      envOf({ REPORT_POW_DIFFICULTY: 'nope', REPORT_POW_TTL_MS: '-5', REPORT_DAILY_LIMIT: '0' }),
    );
    expect(config.powDifficulty).toBe(20);
    expect(config.powTtlMs).toBe(600_000);
    expect(config.dailyLimit).toBe(2000);
  });
});

interface ChallengeBody {
  challenge?: string;
  difficulty?: number;
  expiresAt?: number;
  algorithm?: string;
  enabled?: boolean;
}

/** GET /v1/challenge 并返回解析后的 JSON body。 */
async function getChallenge(
  deps: TestRig['deps'],
  headers: Record<string, string> = {},
): Promise<{ status: number; body: ChallengeBody }> {
  const { res, body } = await get(deps, '/v1/challenge', headers);
  return { status: res.status, body: body as ChallengeBody };
}

/** POST 带 proof 的举报（payload 顶层兄弟键；hash 契约不含 proof）。 */
async function postWithProof(
  deps: TestRig['deps'],
  payload: ReportPayload,
  proof: { challenge: string; solution: string } | null,
  opts: { ip?: string } = {},
): Promise<Res> {
  const body = proof === null ? payload : { ...payload, proof };
  return postReport(deps, body as ReportPayload, opts);
}

describe('challenge endpoint (GET /v1/challenge)', () => {
  it('issues a well-formed v1 challenge: token shape, difficulty, expiry, algorithm', async () => {
    const rig = powRig();
    const { status, body } = await getChallenge(rig.deps);
    expect(status).toBe(200);
    // 协议 v1 形状：恰好这四个键。
    expect(Object.keys(body).sort()).toEqual(['algorithm', 'challenge', 'difficulty', 'expiresAt']);
    expect(body.algorithm).toBe('sha256');
    expect(body.difficulty).toBe(8);
    expect(body.expiresAt).toBe(rig.now() + 600_000);
    const token = body.challenge ?? '';
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('v1');
    const payload = decodeChallengeToken(token);
    expect(payload).toMatchObject({ exp: rig.now() + 600_000, d: 8, ipf: '' });
    expect(payload?.n).toMatch(/^[0-9a-f]{32}$/);
    // 日志只有路由行：token 内容永不进 console（§8）。
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  it('binds the token to the request ip_hash when salt and header are present', async () => {
    const rig = powRig({ ipHashSalt: 'pow-ip-salt' });
    const { body } = await getChallenge(rig.deps, { 'cf-connecting-ip': '198.51.100.7' });
    expect(decodeChallengeToken(body.challenge ?? '')?.ipf).toBe(
      await ipHashOf('pow-ip-salt', '198.51.100.7'),
    );
  });

  it('disabled mode (difficulty=0): enabled:false shape without a challenge', async () => {
    const { status, body } = await getChallenge(rig.deps);
    expect(status).toBe(200);
    expect(body.enabled).toBe(false);
    expect(body.difficulty).toBe(0);
    expect(body.algorithm).toBe('sha256');
    expect(body.challenge).toBeUndefined();
  });

  it('POST to the challenge endpoint is 405', async () => {
    const { res } = await send(rig.deps, '/v1/challenge', { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });
});

describe('proof-of-work enforcement (step 6.5, task 5A)', () => {
  it('full flow: endpoint challenge -> solve -> 201, and the proof never enters the payload hash', async () => {
    const rig = powRig();
    const { body: challenge } = await getChallenge(rig.deps);
    const payload = decodeChallengeToken(challenge.challenge ?? '')!;
    // 测试侧独立求解器（node:crypto）与 Worker 验证端（WebCrypto）同规则互证。
    const solution = solvePow(payload.n, payload.d);
    const fixture = cloneFixture();
    const { res, body } = await postWithProof(
      rig.deps,
      fixture,
      { challenge: challenge.challenge!, solution },
    );
    expect(res.status).toBe(201);
    expect(body).toEqual({ status: 'accepted', id: fixture.reportId });
    // proof 不进 hash：入库的 payload_hash 与 fixture 固定向量一致。
    const row = rig.d1.rows<{ payload_hash: string }>('SELECT payload_hash FROM reports')[0]!;
    expect(row.payload_hash).toBe(loadFixture().hashes.payload);
    // 日志无 challenge / solution 原文。
    expect(JSON.stringify(logs)).not.toContain(challenge.challenge!);
    expect(JSON.stringify(logs)).not.toContain(solution);
  });

  it('missing proof -> 400 missing_proof even for an already-stored reportId (no dedupe read)', async () => {
    const rig = powRig();
    const { body: challenge } = await getChallenge(rig.deps);
    const payload = decodeChallengeToken(challenge.challenge ?? '')!;
    const solution = solvePow(payload.n, payload.d);
    expect(
      (await postWithProof(rig.deps, cloneFixture(), { challenge: challenge.challenge!, solution }))
        .res.status,
    ).toBe(201);
    // 同 reportId 重发但不带 proof：PoW 先于 reportId 幂等（步骤 6.5 < 7），不会拿到 duplicate。
    const again = await postWithProof(rig.deps, cloneFixture(), null);
    expect(again.res.status).toBe(400);
    expect(again.body).toEqual({ error: 'missing_proof' });
    // challenge 失败不写单次使用表（首条 201 的那行不受影响）、不碰日上限计数。
    expect(rig.d1.rows('SELECT * FROM report_pow_used')).toHaveLength(1);
    expect(rig.d1.rows<{ count: number }>('SELECT count FROM report_daily')).toEqual([{ count: 1 }]);
  });

  it('a signature from another secret -> challenge_invalid', async () => {
    const rig = powRig();
    const built = makeProof(rig, { secret: 'not-the-deploy-secret' });
    const { res, body } = await postWithProof(rig.deps, cloneFixture(), built.proof);
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: 'challenge_invalid' });
  });

  it('malformed tokens -> challenge_invalid', async () => {
    const rig = powRig();
    for (const challenge of ['garbage', 'v1.only-two', 'v2.aaa.bbb', 'v1.!!!.???']) {
      const { res, body } = await postWithProof(rig.deps, cloneFixture(), {
        challenge,
        solution: 'x',
      });
      expect(res.status).toBe(400);
      expect(body).toEqual({ error: 'challenge_invalid' });
    }
  });

  it('expired challenge -> challenge_expired', async () => {
    const rig = powRig();
    const built = makeProof(rig, { exp: rig.now() - 1 });
    const { res, body } = await postWithProof(rig.deps, cloneFixture(), built.proof);
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: 'challenge_expired' });
  });

  it('token issued for another IP -> challenge_ip_mismatch; matching IP passes', async () => {
    const rig = powRig({ ipHashSalt: 'pow-ip-salt' });
    const { body: challenge } = await getChallenge(rig.deps, { 'cf-connecting-ip': '198.51.100.7' });
    const payload = decodeChallengeToken(challenge.challenge ?? '')!;
    const solution = solvePow(payload.n, payload.d);
    // 换 IP 提交（防换 IP 重放）：ipf 与本次请求的 ip_hash 不符。
    const wrong = await postWithProof(
      rig.deps,
      cloneFixture(),
      { challenge: challenge.challenge!, solution },
      { ip: '203.0.113.55' },
    );
    expect(wrong.res.status).toBe(400);
    expect(wrong.body).toEqual({ error: 'challenge_ip_mismatch' });
    // 同 IP 提交 → 通过（并走到 201）。
    const right = await postWithProof(
      rig.deps,
      cloneFixture(),
      { challenge: challenge.challenge!, solution },
      { ip: '198.51.100.7' },
    );
    expect(right.res.status).toBe(201);
  });

  it('unset salt: empty ipf on both sides passes regardless of a present header', async () => {
    const rig = powRig();
    const { body: challenge } = await getChallenge(rig.deps);
    const payload = decodeChallengeToken(challenge.challenge ?? '')!;
    const solution = solvePow(payload.n, payload.d);
    const { res } = await postWithProof(
      rig.deps,
      cloneFixture(),
      { challenge: challenge.challenge!, solution },
      { ip: '203.0.113.99' },
    );
    expect(res.status).toBe(201);
  });

  it('a solution below the difficulty -> proof_invalid', async () => {
    const rig = powRig();
    const built = makeProof(rig, { solution: 'not-a-real-solution' });
    const { res, body } = await postWithProof(rig.deps, cloneFixture(), built.proof);
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: 'proof_invalid' });
  });

  it('a solution with exactly d leading zero bits passes (boundary)', async () => {
    const rig = powRig({ powDifficulty: 8 });
    const built = makeProof(rig, { d: 8 });
    const exact = solvePowExactBits(built.payload.n, 8);
    expect(exact).not.toBeNull();
    const { res } = await postWithProof(rig.deps, cloneFixture(), {
      challenge: built.token,
      solution: exact!,
    });
    expect(res.status).toBe(201);
  });

  it('replaying a spent challenge with a new reportId -> challenge_reused', async () => {
    const rig = powRig();
    const built = makeProof(rig);
    expect((await postWithProof(rig.deps, cloneFixture(), built.proof)).res.status).toBe(201);
    // 同 challenge 换 reportId（预解算池重放）：单次使用表拒绝。
    const replay = await postWithProof(
      rig.deps,
      await finalize(makeVariant(cloneFixture())),
      built.proof,
    );
    expect(replay.res.status).toBe(400);
    expect(replay.body).toEqual({ error: 'challenge_reused' });
    expect(rig.d1.rows('SELECT * FROM report_pow_used')).toHaveLength(1);
  });

  it('same reportId + same proof resends are idempotent (crash resend passes PoW, hits duplicate)', async () => {
    const rig = powRig();
    const built = makeProof(rig);
    const fixture = cloneFixture();
    expect((await postWithProof(rig.deps, fixture, built.proof)).res.status).toBe(201);
    const resend = await postWithProof(rig.deps, fixture, built.proof);
    expect(resend.res.status).toBe(200);
    expect(resend.body).toEqual({ status: 'duplicate', reason: 'report_id' });
    expect(rig.d1.rows('SELECT * FROM reports')).toHaveLength(1);
  });

  it('difficulty=0 escape hatch: submissions are accepted without any proof', async () => {
    // rig.deps 是默认 config（powDifficulty 0）。
    const { res, body } = await postReport(rig.deps, cloneFixture());
    expect(res.status).toBe(201);
    expect(body).toEqual({ status: 'accepted', id: loadFixture().reportId });
    expect(rig.d1.rows('SELECT * FROM report_pow_used')).toHaveLength(0);
  });

  it('a bare malformed proof object is missing_proof, not a crash', async () => {
    const rig = powRig();
    for (const proof of [null, 'string', 42, {}, { challenge: 'v1.aaa.bbb' }, { solution: 'x' }]) {
      const { res } = await post(rig.deps, '/v1/reports', {
        ...cloneFixture(),
        ...(proof !== null && typeof proof === 'object' ? { proof } : {}),
      });
      expect(res.status).toBe(400);
    }
  });
});

describe('global daily cap (step 10.5, task 5A)', () => {
  function dailyRig(): TestRig {
    return makeDeps({ config: { dailyLimit: 3, rateLimitMs: 0 } });
  }

  it('accepts up to the limit, then 429 with Retry-After to the next UTC midnight', async () => {
    const rig = dailyRig();
    for (let i = 0; i < 3; i += 1) {
      const payload = await finalize(makeVariant(cloneFixture(), { clientId: `client-${i}` }));
      const { res } = await postReport(rig.deps, payload);
      expect(res.status).toBe(201);
    }
    const over = await postReport(
      rig.deps,
      await finalize(makeVariant(cloneFixture(), { clientId: 'client-over' })),
    );
    expect(over.res.status).toBe(429);
    expect((over.body as { error: string }).error).toBe('rate_limited');
    // Retry-After 指向次日 UTC 零点。
    const d = new Date(rig.now());
    const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    const retryAfterMs = midnight - rig.now();
    expect((over.body as { retryAfterMs: number }).retryAfterMs).toBe(retryAfterMs);
    expect(over.res.headers.get('retry-after')).toBe(String(Math.ceil(retryAfterMs / 1000)));
    // 原子 upsert 先计数后比较：被拒的第 4 条也消耗了计数（与 IP 限流同语义）。
    const rows = rig.d1.rows<{ day: string; count: number }>('SELECT * FROM report_daily');
    expect(rows).toEqual([{ day: utcDayOf(rig.now()), count: 4 }]);
  });

  it('resets after the UTC day rolls over (injected clock)', async () => {
    const rig = dailyRig();
    for (let i = 0; i < 4; i += 1) {
      await postReport(rig.deps, await finalize(makeVariant(cloneFixture(), { clientId: `c${i}` })));
    }
    const d = new Date(rig.now());
    rig.advance(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - rig.now() + 1,
    );
    const next = await postReport(
      rig.deps,
      await finalize(makeVariant(cloneFixture(), { clientId: 'client-next-day' })),
    );
    expect(next.res.status).toBe(201);
    // 昨天的计数行仍在（cron 才清），新的一天从 1 重新起算。
    const rows = rig.d1.rows<{ day: string; count: number }>('SELECT * FROM report_daily');
    expect(rows).toContainEqual({ day: utcDayOf(rig.now()), count: 1 });
    expect(rows).toHaveLength(2);
  });

  it('duplicates never consume the daily quota (dedupe precedes the cap)', async () => {
    const rig = dailyRig();
    const first = cloneFixture();
    expect((await postReport(rig.deps, first)).res.status).toBe(201);
    for (let i = 0; i < 3; i += 1) {
      const { res } = await postReport(
        rig.deps,
        await finalize(makeVariant(cloneFixture(), { clientId: `c${i}` })),
      );
      expect(res.status).toBe(i < 2 ? 201 : 429);
    }
    // 重复点击（content 去重命中）在步骤 8 就返回，不占日额度（计数停在 4，不再增长）。
    const dup = await postReport(
      rig.deps,
      await finalize(makeVariant(cloneFixture(), { keepText: true })),
    );
    expect(dup.res.status).toBe(200);
    expect(dup.body).toEqual({ status: 'duplicate', reason: 'content' });
    expect(rig.d1.rows<{ count: number }>('SELECT count FROM report_daily')[0]).toEqual({
      count: 4,
    });
  });

  it('bumpDailyCount is atomic per call and grows monotonically', async () => {
    const rig = dailyRig();
    expect(await bumpDailyCount(rig.deps.db, '2026-11-27')).toBe(1);
    expect(await bumpDailyCount(rig.deps.db, '2026-11-27')).toBe(2);
    expect(await bumpDailyCount(rig.deps.db, '2026-11-28')).toBe(1);
  });
});

describe('cron cleanup extension (task 5A: pow + daily rows)', () => {
  it('deletes pow rows older than a day and daily rows older than 7 days', async () => {
    seedPowUsed(rig.d1, 'pow_old', 'rep_x', NOW - 25 * 3600_000);
    seedPowUsed(rig.d1, 'pow_fresh', 'rep_y', NOW - 1 * 3600_000);
    seedDaily(rig.d1, utcDayOf(NOW - 8 * 86_400_000), 5);
    seedDaily(rig.d1, utcDayOf(NOW - 2 * 86_400_000), 7);
    seedReport(rig.d1, { id: 'rep_old', clientId: 'c1', receivedAt: NOW - 366 * 24 * 3600_000 });
    seedRate(rig.d1, 'c_stale', NOW - 25 * 3600_000);
    seedIpRate(rig.d1, 'ip_old', NOW - 2 * 3_600_000);

    const counts = await runCleanup(rig.deps.db, rig.deps.config, NOW);
    expect(counts).toEqual({ reports: 1, clientRate: 1, ipRate: 1, powUsed: 1, daily: 1 });
    expect(
      rig.d1.rows<{ challenge_id: string }>('SELECT challenge_id FROM report_pow_used'),
    ).toEqual([{ challenge_id: 'pow_fresh' }]);
    expect(rig.d1.rows<{ day: string }>('SELECT day FROM report_daily')).toEqual([
      { day: utcDayOf(NOW - 2 * 86_400_000) },
    ]);
  });
});

describe('response headers (§8 output trio, no CORS)', () => {
  it('every response carries the trio and never a CORS header', async () => {
    const responses: Response[] = [];
    responses.push((await get(rig.deps, '/healthz')).res);
    responses.push((await postReport(rig.deps, cloneFixture())).res); // 201
    responses.push((await postReport(rig.deps, cloneFixture())).res); // 200 duplicate
    responses.push((await post(rig.deps, '/v1/reports', '{"a":')).res); // 400
    responses.push(
      (await post(rig.deps, '/v1/reports', cloneFixture(), { 'content-type': 'text/plain' })).res, // 415
    );
    responses.push(
      (await post(rig.deps, '/v1/reports', `{"a":"${'x'.repeat(140_000)}"}`)).res,
    ); // 413
    responses.push((await send(rig.deps, '/v1/reports', { method: 'GET' })).res); // 405
    responses.push((await get(rig.deps, '/nope')).res); // 404
    // 429: second distinct message within the client window
    responses.push(
      (await postReport(rig.deps, await finalize(makeVariant(cloneFixture())))).res,
    );

    expect(responses.map((r) => r.status)).toEqual(
      expect.arrayContaining([200, 201, 400, 404, 405, 413, 415, 429]),
    );
    for (const res of responses) {
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('access-control-allow-methods')).toBeNull();
      expect(res.headers.get('vary')).toBeNull();
    }
  });
});

describe('logging (§7.4 step 12 / §8)', () => {
  it('logs only {reportId,status,httpStatus} or {path,method,status}', async () => {
    logs.length = 0;
    const token = 'admin-secret-token';
    await postReport(rig.deps, cloneFixture(), { ip: '203.0.113.9' }); // 201
    await postReport(rig.deps, cloneFixture()); // 200 duplicate
    await post(rig.deps, '/v1/reports', '{"broken'); // 400
    await get(rig.deps, '/healthz');
    await get(rig.deps, '/v1/admin/reports', { authorization: `Bearer ${token}` }); // 404 (no token configured)
    const payload = await finalize(makeVariant(cloneFixture()));
    payload.client.id = 'client-9f21c7d4a55e';
    await postReport(rig.deps, payload); // 429

    expect(logs.length).toBeGreaterThanOrEqual(6);
    for (const line of logs) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(typeof parsed).toBe('object');
      if ('reportId' in parsed) {
        expect(Object.keys(parsed).sort()).toEqual(['httpStatus', 'reportId', 'status']);
      } else {
        expect(Object.keys(parsed).sort()).toEqual(['method', 'path', 'status']);
      }
      // 泄漏断言：正文片段 / clientId / IP / token 绝不出现
      expect(line).not.toContain('销售数据');
      expect(line).not.toContain('client-9f21c7d4a55e');
      expect(line).not.toContain('203.0.113.9');
      expect(line).not.toContain(token);
    }
  });

  it('admin resource ids never reach the logs (clientId in a DELETE path)', async () => {
    logs.length = 0;
    const adminToken = 'logs-admin-token';
    const deps = makeDeps({ config: { adminToken } });
    const clientId = 'client-LOG-LEAK-CHECK';
    const res = await send(deps.deps, `/v1/admin/clients/${clientId}`, {
      method: 'DELETE',
      headers: bearer(adminToken),
    });
    expect(res.res.status).toBe(200);
    const detail = await get(deps.deps, '/v1/admin/reports/rep_some_id', bearer(adminToken));
    expect(detail.res.status).toBe(404);
    // path 折叠到集合级：资源段（clientId / reportId）不落日志（§8）。
    expect(logs).toContain(JSON.stringify({ path: '/v1/admin/clients', method: 'DELETE', status: 200 }));
    expect(logs).toContain(JSON.stringify({ path: '/v1/admin/reports', method: 'GET', status: 404 }));
    for (const line of logs) expect(line).not.toContain(clientId);
    expect(logs.join('\n')).not.toContain('rep_some_id');
  });
});

describe('cron cleanup (§7.3 retention)', () => {
  it('deletes expired reports, stale client-rate rows and past ip windows', async () => {
    seedReport(rig.d1, { id: 'rep_old', clientId: 'c1', receivedAt: NOW - 366 * 24 * 3600_000 });
    seedReport(rig.d1, { id: 'rep_keep', clientId: 'c1', receivedAt: NOW - 100 * 24 * 3600_000 });
    seedRate(rig.d1, 'c_stale', NOW - 25 * 3600_000); // older than 24h -> gone
    seedRate(rig.d1, 'c_fresh', NOW - 1 * 3600_000); // kept
    seedIpRate(rig.d1, 'ip_old', NOW - 2 * 3_600_000); // window passed -> gone
    seedIpRate(rig.d1, 'ip_fresh', NOW - 1 * 3_600_000, 5); // current window -> kept

    const counts = await runCleanup(rig.deps.db, rig.deps.config, NOW);
    expect(counts).toEqual({ reports: 1, clientRate: 1, ipRate: 1, powUsed: 0, daily: 0 });
    expect(rig.d1.rows('SELECT id FROM reports').map((r) => (r as { id: string }).id)).toEqual([
      'rep_keep',
    ]);
    expect(rig.d1.rows('SELECT client_id FROM report_rate').map((r) => (r as { client_id: string }).client_id)).toEqual(['c_fresh']);
    expect(rig.d1.rows('SELECT ip_hash FROM report_ip_rate').map((r) => (r as { ip_hash: string }).ip_hash)).toEqual(['ip_fresh']);
  });
});

describe('misc', () => {
  it('splitModelRef splits provider/model on the first slash', () => {
    expect(splitModelRef('openai/gpt-5.1')).toEqual({ provider: 'openai', id: 'gpt-5.1' });
    expect(splitModelRef('openai/custom/thing')).toEqual({ provider: 'openai', id: 'custom/thing' });
    expect(splitModelRef('plain-model')).toEqual({ provider: '', id: 'plain-model' });
    expect(splitModelRef('')).toEqual({ provider: '', id: '' });
  });

  it('stores the derived triage columns on accept', async () => {
    await postReport(rig.deps, cloneFixture());
    const row = rig.d1.rows<Record<string, unknown>>('SELECT * FROM reports')[0]!;
    expect(row.bot_name).toBe('小助手');
    expect(row.model_provider).toBe('openai');
    expect(row.model_id).toBe('gpt-5.1');
    expect(row.message_kind).toBe('text');
    expect(row.app_version).toBe('0.6.2');
    expect(row.platform).toBe('win32');
    expect(row.source_kind).toBe('local');
    expect(row.status).toBe('new');
    expect(row.received_at).toBe(NOW);
  });
});
