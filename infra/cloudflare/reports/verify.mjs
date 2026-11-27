#!/usr/bin/env node
// 线上冒烟脚本（todo/ai-content-reporting.md §10.4 / §11.1 第 5 步）：部署后对
// https://reports.kepcup.com 逐项验证公开管线与 admin API。零依赖，Node ≥20 的内置
// fetch（node --env-file=.env 读取 KEPCUP_REPORT_ADMIN_TOKEN；KEPCUP_REPORT_ENDPOINT
// 可覆盖默认域名，供未来同一脚本测预发）。
//
//   node --env-file=.env infra/cloudflare/reports/verify.mjs
//
// 检查项（对应 §7.4 管线顺序与 §7.6 admin）：
//   1. GET  /healthz                    200 且 {ok:true, version 有值}
//   2. POST /v1/reports 坏 JSON         400
//   3. POST /v1/reports 合法 payload    201 {status:'accepted'}（自建 fixture，
//      hash 按方案 §5.4 在脚本内以 canonicalJson+sha256 计算）
//   4. 同内容再发（新 reportId）        200 {status:'duplicate'}，且不占限流名额
//   5. 立即发不同内容（同 client）      429 + Retry-After / retryAfterMs
//   6. GET  /v1/admin/reports 无 token  404 或 401（记录实际值）
//   7. 有 token：list 含刚才的行 → PATCH dismissed → stats 200 →
//      DELETE /v1/admin/clients/<client> 200 → 再 list 该 client 为空
//   P. PoW 反滥用（任务 5A，独立 clientId，不与上面各步串名额）：
//      GET /v1/challenge → 求解 → 201；同 proof 换 reportId → 400 challenge_reused；
//      无 proof → 400 missing_proof。服务端 PoW 关闭（difficulty=0）时降级为
//      「无 proof → 201」并标注。
// 脚本自己清理：结束前确保 verify 用的测试行已被 delete-client 删掉（即使中途失败也
// 尽力删除）。token 永不打印；challenge / solution 原文也不打印。
//
// 注意：clientId 与正文都带每次随机的后缀，去重按 (client_id, hash, bucket) 计——
// 重跑（哪怕 60 秒内连跑）不会命中上一轮的去重/限流行，第 3 步仍是 201（已实测）。
// 只有为调试把后缀固定时，重跑第 3 步才会拿到 200 duplicate；此时等一分钟没用
// （content 去重窗口 24 小时），换后缀或改正文即可。

import { createHash, createHmac, randomBytes } from 'node:crypto';

const DEFAULT_ENDPOINT = 'https://reports.kepcup.com';
const TIMEOUT_MS = 20_000;
const TOKEN = process.env.KEPCUP_REPORT_ADMIN_TOKEN;
const base = (process.env.KEPCUP_REPORT_ENDPOINT ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');

if (!TOKEN) {
  console.error(
    'FAIL  缺少 KEPCUP_REPORT_ADMIN_TOKEN —— 用 node --env-file=.env 运行，或在环境里提供该变量。\n' +
      '      （token 只放 .env / Worker secret，本脚本不打印它的值。）',
  );
  process.exit(2);
}

// ---------------------------------------------------------------- §5.4 hash

/**
 * 与 infra/cloudflare/reports/src/dedupe.ts 逐字对应的 canonicalJson（Worker 与 core
 * 各有一份，脚本这是第三份只读实现）：对象键按默认字符串比较排序、数组保序、其余
 * JSON.stringify 语义。payload 里没有 undefined，这里只需覆盖 JSON 值。
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

const sha256Hex = (input) => createHash('sha256').update(input, 'utf8').digest('hex');

// ---------------------------------------------------------------- PoW（任务 5A）

/** sha256 摘要的前导零比特数（难度度量，协议 v1；与 Worker src/pow.ts 同规则）。 */
function leadingZeroBits(digest) {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    let mask = 0x80;
    while (mask !== 0 && (byte & mask) === 0) {
      bits += 1;
      mask >>= 1;
    }
    break;
  }
  return bits;
}

/**
 * 求解器（协议 v1）：找 ASCII solution 使 sha256(utf8(n + ':' + solution)) 的前导
 * 零比特数 ≥ difficulty。difficulty 20 ≈ 2^20 次 sha256，Node 单核约 0.3-1s。
 * 上限 2^24 次，超过抛错（服务端配置异常时不该挂死）。
 */
function solveChallenge(nonce, difficulty) {
  const MAX = 16_777_216;
  for (let i = 0; i < MAX; i += 1) {
    const solution = i.toString(36);
    const digest = createHash('sha256').update(`${nonce}:${solution}`, 'utf8').digest();
    if (leadingZeroBits(digest) >= difficulty) return solution;
  }
  throw new Error(`pow: difficulty ${difficulty} 未能在 ${MAX} 次内解出（服务端配置异常？）`);
}

/** 解 challenge token 的 payload 段（`v1.<payload>.<hmac>` 中段）→ {n, exp, d, ipf}。 */
function decodeChallengePayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** 与 Worker src/pow.ts issueChallenge 同构的 token（本地固定向量自检用，只打印 PASS/FAIL）。 */
function signChallengeToken(payload, secret) {
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(Buffer.from(`v1.${payloadPart}`, 'utf8'))
    .digest();
  return `v1.${payloadPart}.${mac.toString('base64url')}`;
}

// ---------------------------------------------------------------- fixture

const suffix = randomBytes(8).toString('hex');
let messageSeq = 0;

/** 完整举报 payload（镜像 packages/shared/test/fixtures/report-v1.json 的形状）。 */
function buildFixture(messageText, clientIdValue = `verify-${suffix}`) {
  return {
    schemaVersion: 1,
    // reportId/createdAt 在 makeReport 里补齐（参与校验但不参与 payload hash）
    reportId: '',
    createdAt: Date.now(),
    reason: 'inappropriate',
    client: {
      id: clientIdValue,
      surface: 'desktop',
      appVersion: '0.0.0-verify',
      platform: process.platform,
      osVersion: 'verify-smoke',
      arch: process.arch,
      locale: 'en-US',
    },
    source: { kind: 'local' },
    conversation: { id: `conv_verify_${suffix}`, type: 'direct' },
    bot: {
      id: 'bot_verify_smoke',
      name: 'verify-smoke',
      systemRole: null,
      runtime: {
        model: 'verify/test-model',
        lightModel: '',
        backgroundModel: '',
        agent: { id: 'builtin', model: '', effort: '' },
      },
      profile: { note: 'verify smoke fixture' },
    },
    message: {
      id: `msg_verify_${suffix}_${messageSeq++}`,
      seq: 1,
      kind: 'text',
      status: 'normal',
      createdAt: Date.now(),
      editedAt: null,
      runId: null,
      text: messageText,
      content: null,
      truncated: false,
      attachments: [],
    },
    replyTo: { messageId: `msg_verify_reply_${suffix}`, text: 'verify smoke replyTo' },
    context: [
      {
        messageId: `msg_verify_ctx_${suffix}`,
        senderType: 'user',
        kind: 'text',
        text: 'verify smoke context',
        createdAt: Date.now(),
      },
    ],
    usage: [{ provider: 'verify', model: 'verify-model', loopType: 'turn', calls: 1, inputTokens: 0, outputTokens: 0 }],
    tools: [{ name: 'verify_probe', calls: 0 }],
    providers: [{ id: 'verify', name: 'Verify', vendor: 'verify', api: 'verify-api' }],
  };
}

/** 组装可直接 POST 的 body：补 reportId/createdAt 并按 §5.4 计算两个 hash（proof 是传输层字段，不进 hash）。 */
function makeReport(messageText, clientIdValue = `verify-${suffix}`) {
  const payload = buildFixture(messageText, clientIdValue);
  payload.reportId = `rep_verify_${suffix}_${messageSeq}`;
  payload.createdAt = Date.now();
  payload.hashes = {
    content: sha256Hex(payload.message.text), // text 消息的 content hash = 正文原文
    payload: sha256Hex(
      canonicalJson(
        Object.fromEntries(
          Object.entries(payload).filter(
            ([k]) => k !== 'reportId' && k !== 'createdAt' && k !== 'hashes' && k !== 'proof',
          ),
        ),
      ),
    ),
  };
  return payload;
}

// ---------------------------------------------------------------- harness

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON 响应按原文处理
  }
  return { response, text, json };
}

const adminHeaders = { authorization: `Bearer ${TOKEN}` };
const clientId = `verify-${suffix}`;
// PoW 冒烟用独立 client：不与既有步骤串限流/去重/日额度（任务 5A）。
const powClientId = `verify-pow-${suffix}`;
let cleanupDone = false;

async function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  for (const [name, id] of [
    [`cleanup（DELETE /v1/admin/clients/${clientId}）`, clientId],
    [`cleanup（DELETE /v1/admin/clients/${powClientId}）`, powClientId],
  ]) {
    try {
      const { response } = await request(`/v1/admin/clients/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: adminHeaders,
      });
      check(name, response.status === 200, `HTTP ${response.status}`);
    } catch (error) {
      check('cleanup（DELETE client）', false, error instanceof Error ? error.message : String(error));
    }
  }
}

// ---------------------------------------------------------------- checks

try {
  // 1. /healthz
  {
    const { response, json } = await request('/healthz');
    const ok =
      response.status === 200 &&
      json !== null &&
      typeof json === 'object' &&
      json.ok === true &&
      typeof json.version === 'string' &&
      json.version.length > 0;
    check('GET /healthz → 200 {ok:true, version}', ok, `HTTP ${response.status}, version=${json?.version}`);
  }

  // 2. 坏 JSON → 400
  {
    const { response, json } = await request('/v1/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"reportId": not-json',
    });
    check('POST /v1/reports 坏 JSON → 400', response.status === 400, `HTTP ${response.status}, error=${json?.error}`);
  }

  // 3. 合法 payload → 201 accepted
  const first = makeReport(`verify smoke 正文 ${suffix} —— first`);
  {
    const { response, json } = await request('/v1/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(first),
    });
    const ok =
      response.status === 201 && json?.status === 'accepted' && (json?.id === undefined || json.id === first.reportId);
    check(
      'POST /v1/reports 合法 payload → 201 {status:"accepted"}',
      ok,
      `HTTP ${response.status}, body=${JSON.stringify(json)}`,
    );
    if (response.status !== 201) await cleanup(); // 没入库就不用走 admin 段，但仍清 rate 行
  }

  // 4. 同内容再发（新 reportId）→ 200 duplicate（去重先于限流，不占名额）
  {
    const replay = makeReport(`verify smoke 正文 ${suffix} —— first`);
    const { response, json } = await request('/v1/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(replay),
    });
    check(
      'POST 同内容（新 reportId）→ 200 {status:"duplicate"}',
      response.status === 200 && json?.status === 'duplicate',
      `HTTP ${response.status}, body=${JSON.stringify(json)}`,
    );
  }

  // 5. 立即发不同内容（同 client）→ 429 + Retry-After/retryAfterMs
  {
    const different = makeReport(`verify smoke 正文 ${suffix} —— second（应被限流）`);
    const { response, json } = await request('/v1/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(different),
    });
    const retryHeader = response.headers.get('retry-after');
    const ok = response.status === 429 && (retryHeader !== null || typeof json?.retryAfterMs === 'number');
    check(
      'POST 不同内容（同 client）→ 429 带 Retry-After/retryAfterMs',
      ok,
      `HTTP ${response.status}, Retry-After=${retryHeader}, retryAfterMs=${json?.retryAfterMs}`,
    );
  }

  // 6. admin 无 token → 404 或 401（隐藏入口 / 拒绝）
  {
    const { response } = await request('/v1/admin/reports');
    const ok = response.status === 401 || response.status === 404;
    check(`GET /v1/admin/reports 无 token → 401/404（实际 ${response.status}）`, ok, `HTTP ${response.status}`);
  }

  // 7a. 有 token：list 含刚才的行
  {
    const { response, json } = await request(`/v1/admin/reports?client=${encodeURIComponent(clientId)}`, {
      headers: adminHeaders,
    });
    const found = json?.reports?.some((row) => row.id === first.reportId) ?? false;
    check(
      'GET /v1/admin/reports?client=… 含刚才的行',
      response.status === 200 && found,
      `HTTP ${response.status}, rows=${json?.reports?.length ?? 'n/a'}`,
    );
  }

  // 7b. PATCH dismissed + note
  {
    const { response, json } = await request(`/v1/admin/reports/${first.reportId}`, {
      method: 'PATCH',
      headers: { ...adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'dismissed', note: 'verify smoke' }),
    });
    check(
      `PATCH /v1/admin/reports/${first.reportId} status=dismissed → 200`,
      response.status === 200 && json?.status === 'dismissed',
      `HTTP ${response.status}, body=${JSON.stringify(json)}`,
    );
  }

  // 7c. stats
  {
    const { response, json } = await request('/v1/admin/stats', { headers: adminHeaders });
    const ok = response.status === 200 && json !== null && typeof json.byStatus === 'object' && json.byStatus !== null;
    check('GET /v1/admin/stats → 200', ok, `HTTP ${response.status}, byStatus=${JSON.stringify(json?.byStatus)}`);
  }

  // 7d. 删除该 client 全部数据
  {
    const { response, json } = await request(`/v1/admin/clients/${encodeURIComponent(clientId)}`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
    check(
      `DELETE /v1/admin/clients/${clientId} → 200`,
      response.status === 200 && json?.status === 'deleted',
      `HTTP ${response.status}, body=${JSON.stringify(json)}`,
    );
    cleanupDone = true;
  }

  // 7e. 再查该 client 为空（清理生效）
  {
    const { response, json } = await request(`/v1/admin/reports?client=${encodeURIComponent(clientId)}`, {
      headers: adminHeaders,
    });
    check(
      'DELETE 后再 list 该 client 为空',
      response.status === 200 && Array.isArray(json?.reports) && json.reports.length === 0,
      `HTTP ${response.status}, rows=${json?.reports?.length ?? 'n/a'}`,
    );
  }

  // P. PoW 反滥用（任务 5A，独立 powClientId）：challenge → solve → 201；
  //    同 proof 换 reportId → 400 challenge_reused；无 proof → 400 missing_proof。
  //    服务端 PoW 关闭（difficulty=0 / secret 未配）时降级为「无 proof → 201」。
  {
    // 本地自检：脚本自己的 token 构造 / 解码 / 求解器互证（不联网）。
    const localToken = signChallengeToken(
      { n: 'ab'.repeat(16), exp: Date.now() + 600_000, d: 8, ipf: '' },
      'verify-local-selfcheck',
    );
    const localPayload = decodeChallengePayload(localToken);
    const localSolution = localPayload === null ? '' : solveChallenge(localPayload.n, localPayload.d);
    const localDigest = createHash('sha256')
      .update(`${localPayload?.n}:${localSolution}`, 'utf8')
      .digest();
    check(
      'PoW 本地自检（token 构造/解码/求解规则互证）',
      localPayload !== null &&
        localPayload.n === 'ab'.repeat(16) &&
        leadingZeroBits(localDigest) >= (localPayload?.d ?? Infinity),
      `difficulty=${localPayload?.d}, bits=${leadingZeroBits(localDigest)}`,
    );

    const { response, json } = await request('/v1/challenge');
    const enabled =
      response.status === 200 &&
      typeof json?.challenge === 'string' &&
      json.challenge.length > 0;
    check(
      'GET /v1/challenge → 200（enabled 形状含 challenge/difficulty/expiresAt/algorithm）',
      response.status === 200 && (enabled || json?.enabled === false),
      `HTTP ${response.status}, difficulty=${json?.difficulty}, algorithm=${json?.algorithm}`,
    );

    const powReport = makeReport(`verify pow 正文 ${suffix} —— proof`, powClientId);
    if (enabled) {
      const tokenPayload = decodeChallengePayload(json.challenge);
      if (tokenPayload === null || typeof tokenPayload.n !== 'string') {
        check('PoW token 可解析', false, 'challenge token payload 段无法解码');
      } else {
        const solution = solveChallenge(tokenPayload.n, tokenPayload.d);
        const posted = await request('/v1/reports', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...powReport, proof: { challenge: json.challenge, solution } }),
        });
        check(
          `challenge（difficulty ${tokenPayload.d}）→ solve → 201 accepted`,
          posted.response.status === 201 && posted.json?.status === 'accepted',
          `HTTP ${posted.response.status}, body=${JSON.stringify(posted.json)}`,
        );

        // 同 proof 换新 reportId → 400 challenge_reused（单次使用，防预解算池重放）。
        const replay = makeReport(`verify pow 正文 ${suffix} —— replay`, powClientId);
        const reused = await request('/v1/reports', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...replay, proof: { challenge: json.challenge, solution } }),
        });
        check(
          '同 proof 新 reportId → 400 challenge_reused',
          reused.response.status === 400 && reused.json?.error === 'challenge_reused',
          `HTTP ${reused.response.status}, body=${JSON.stringify(reused.json)}`,
        );
      }
    } else {
      // 逃生开关打开（difficulty=0）：无 proof 直发应为 201。
      const posted = await request('/v1/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(powReport),
      });
      check(
        'PoW disabled（difficulty=0）→ 无 proof 201 accepted',
        posted.response.status === 201 && posted.json?.status === 'accepted',
        `HTTP ${posted.response.status}, body=${JSON.stringify(posted.json)}`,
      );
    }

    // 无 proof（PoW 启用时）→ 400 missing_proof；disabled 时跳过（预期就是 201）。
    if (enabled) {
      const bare = makeReport(`verify pow 正文 ${suffix} —— bare`, powClientId);
      const missing = await request('/v1/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bare),
      });
      check(
        '无 proof → 400 missing_proof（不带 Retry-After）',
        missing.response.status === 400 &&
          missing.json?.error === 'missing_proof' &&
          missing.response.headers.get('retry-after') === null,
        `HTTP ${missing.response.status}, body=${JSON.stringify(missing.json)}`,
      );
    }
  }
} catch (error) {
  check('请求执行', false, error instanceof Error ? error.message : String(error));
} finally {
  await cleanup();
}

// ---------------------------------------------------------------- summary

const failed = results.filter((r) => !r.pass);
console.log(`\n${base}  ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  console.error(`FAIL  ${failed.length} 项未通过（见上方 FAIL 行）`);
  process.exit(1);
}
process.stdout.write('OK    举报 Worker 冒烟全部通过\n');
