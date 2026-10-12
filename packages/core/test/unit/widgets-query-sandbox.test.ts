import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { BOT_WIDGET_QUERY_RESULT_MAX_BYTES, BOT_WIDGET_QUERY_ROWS_MAX } from '@kepcup/shared';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';
import {
  WIDGET_QUERY_PHYSICAL_TABLES,
  WidgetQueryGate,
  explainBindings,
  scanSql,
  sqlIdentifiers,
  tableReferenceViolation,
  widgetQueryViewsFor,
} from '../../src/widgets/query-gate.js';
import {
  WidgetQueryRunner,
  resolveQueryDriverPath,
  type WidgetQueryJob,
  type WidgetQueryRunnerOptions,
} from '../../src/widgets/query-runner.js';

/**
 * 组件查询的纵深防御（D81 审查修复，设计 32 §6.1）：名字闸（只能引用作用域视图）、
 * 独立只读子进程里的物理闸（EXPLAIN 的 OpenRead 落在白名单表上）、时限 / 内存上限
 * 杀进程、行数截断判定。服务层的端到端（交付 / 运行时复核 / 预审强制）在
 * widgets-service.test.ts。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'widgets-query-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const KEY = deriveKey(Buffer.alloc(32, 9), KEY_INFO.mainDb);

function openDb(): { db: SqliteDatabase; file: string } {
  const file = path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = openDatabase({ path: file, key: KEY });
  runMigrations(db, migrationsUrl('main'));
  db.exec(`
    insert into bots (id, name, profile_json, status, created_at, updated_at) values ('bot_a', 'A', '{}', 'active', 1, 1);
    insert into conversations (id, type, created_at) values ('conv_1', 'direct', 1), ('conv_2', 'direct', 1);
    insert into widgets (id, bot_id, conversation_id, scope, title, latest_version, created_at, updated_at)
      values ('wgt_a', 'bot_a', 'conv_1', 'conversation', 'A', 1, 1, 1),
             ('wgt_b', 'bot_a', 'conv_1', 'conversation', 'B', 1, 1, 1);
    insert into widget_docs (widget_id, key, value_json, updated_at)
      values ('wgt_a', 'k1', '{"amount":3}', 1), ('wgt_a', 'k2', '{"amount":4}', 1),
             ('wgt_b', 'secret', '{"amount":1000}', 1);
    insert into messages (id, conversation_id, seq, sender_type, kind, content_json, created_at, status)
      values ('m1', 'conv_1', 1, 'user', 'text', '{"text":"你好"}', 1, 'normal'),
             ('m2', 'conv_1', 2, 'user', 'text', '{"text":"撤回了"}', 2, 'recalled'),
             ('m3', 'conv_2', 1, 'user', 'text', '{"text":"别的对话"}', 3, 'normal');
  `);
  // 模拟凭据类表里的数据（真实 secrets 表的列各迁移不同，这里只需一张「不在白名单里」的表）。
  db.exec("create table probe_secrets (v text); insert into probe_secrets values ('s3cr3t');");
  return { db, file };
}

const runners: WidgetQueryRunner[] = [];
afterEach(() => {
  for (const runner of runners.splice(0)) runner.dispose();
});

function runnerFor(
  file: string,
  options?: Omit<WidgetQueryRunnerOptions, 'database'>,
): WidgetQueryRunner {
  const runner = new WidgetQueryRunner({ database: { path: file, key: KEY }, ...options });
  runners.push(runner);
  return runner;
}

function job(sql: string, params: WidgetQueryJob['params'] = {}, widgetId = 'wgt_a'): WidgetQueryJob {
  return {
    owner: widgetId,
    sql,
    params,
    views: widgetQueryViewsFor({ widgetId, conversationId: 'conv_1' }),
    tables: WIDGET_QUERY_PHYSICAL_TABLES,
    explainArgs: explainBindings(sql),
    rowsMax: BOT_WIDGET_QUERY_ROWS_MAX,
    bytesMax: BOT_WIDGET_QUERY_RESULT_MAX_BYTES,
  };
}

describe('WidgetQueryGate（名字闸）', () => {
  const gate = new WidgetQueryGate();
  afterAll(() => gate.dispose());

  it('作用域视图上的只读查询通过（含 CTE / json_each / 子查询 / 参数）', () => {
    for (const sql of [
      "select sum(json_extract(value_json, '$.amount')) as total from widget_kv",
      'select count(*) as n from conversation_messages where sender_type = :who',
      "with t as (select key as k from widget_kv) select t.k, j.value from t, json_each('[1,2]') as j limit 3",
      'select (select count(*) from widget_kv) as kv, (select count(*) from conversation_messages) as msgs',
      'select 1 as one',
      'with recursive c(x) as (select 1 union all select x + 1 from c limit 5) select x from c',
    ]) {
      expect(gate.check(sql), sql).toBeNull();
    }
  });

  it('越界一律拒绝：任意物理表 / main. 前缀 / schema 表 / pragma 表值函数 / dbstat', () => {
    for (const sql of [
      'select * from secrets',
      'select * from app_connections',
      'select * from messages',
      'select * from widget_docs',
      'select * from main.widget_kv',
      'select * from sqlite_master',
      'select * from sqlite_temp_master',
      'select name from pragma_table_list',
      'select * from "pragma_table_info"(\'widgets\')',
      'select * from [dbstat]',
      'select * from widget_kv where key in (select name from sqlite_schema)',
    ]) {
      expect(gate.check(sql), sql).not.toBeNull();
    }
  });

  it('写语句 / PRAGMA / ATTACH / 多语句 / 空语句拒绝', () => {
    for (const sql of [
      "insert into widget_kv values ('k', '1', 1)",
      'delete from widget_kv',
      'with c as (select 1) delete from widget_kv',
      'pragma query_only = off',
      "attach database ':memory:' as x",
      'select 1; select 2',
      '-- only a comment',
      'select * from nope',
    ]) {
      expect(gate.check(sql), sql).not.toBeNull();
    }
  });

  it('sqlIdentifiers：跳过字符串与注释，识别各种引用形式', () => {
    expect(
      sqlIdentifiers(
        `select 'pragma_x' as "Pragma_Y", [dbstat], \`a\`\`b\` -- pragma_z\n/* dbstat */ from t`,
      ),
    ).toEqual(['select', 'as', 'pragma_y', 'dbstat', 'a`b', 'from', 't']);
    // 参数占位：字符串 / 注释里的不算；命名参数去前缀、去重；? 与 ?NNN 取所需位置数。
    expect(scanSql("select :a, @b, $c, :a, ':x', ? , ?3 -- :y")).toMatchObject({
      named: ['a', 'b', 'c'],
      positional: 3,
    });
    expect(explainBindings('select :month as m, ?')).toEqual([null, { month: null }]);
  });

  // 第二轮审查 C：虚表防线从黑名单（只拦 pragma_* / dbstat）改为表引用位置的白名单。
  it('表引用白名单：合法写法照常通过（join / 括号分组 / json_each·json_tree / CTE / IN 列表 / WINDOW / IS DISTINCT FROM）', () => {
    for (const sql of [
      'select k.key, m.text from widget_kv as k join conversation_messages m on m.id = k.key',
      'select count(*) as n from (widget_kv cross join conversation_messages)',
      "select j.key, t.value from widget_kv, json_each(value_json) as j, json_tree('{\"a\":1}') t",
      'select key from widget_kv where key in (key, :k)',
      'select key from widget_kv where key in (select value from json_each(:keys))',
      'select key, row_number() over w as n from widget_kv window w as (order by key)',
      'select key from widget_kv where key is not distinct from :k',
      'with recursive t(n) as (select 1 union all select n + 1 from t where n < 3), u as (select n from t) select * from u, t',
      'select "key" from "widget_kv"',
      'select key from [WIDGET_KV]',
      'select * from (select key from widget_kv) as s, conversation_messages',
    ]) {
      expect(tableReferenceViolation(sql), sql).toBeNull();
      expect(gate.check(sql), sql).toBeNull();
    }
  });

  it('表引用白名单：eponymous 虚表 / 未知表值函数 / 带库名前缀一律拒绝（含大小写、引号、注释、括号与作用域混淆）', () => {
    for (const sql of [
      'select * from sqlite_dbpage',
      "select data from sqlite_dbpage('main')",
      'select * from sqlite_stmt',
      'select * from dbstat',
      'select * from DbStat',
      'select * from "DBSTAT"',
      'select * from `dbstat`',
      'select * from [Sqlite_DbPage]',
      'select * from/**/pragma_table_list',
      'select * from widget_kv, -- 注释\n pragma_database_list',
      'select * from generate_series(1, 10)',
      'select * from GENERATE_SERIES(1, 10)',
      'select * from widget_kv natural join "sqlite_dbpage"',
      'select * from widget_kv where key in sqlite_dbpage',
      'select * from widget_kv where key in generate_series(1, 3)',
      'select * from (widget_kv cross join generate_series(1, 3))',
      'select * from widget_kv where exists (select 1 from json_each(\'[1]\') join sqlite_stmt)',
      // 内层子查询声明的 CTE 名不能在外层借用（外层的 generate_series 是真虚表）。
      'select * from (with generate_series as (select 1 as x) select * from generate_series), generate_series',
      // 先引用、后声明。
      'select * from (select * from fts4aux), (with fts4aux as (select 1) select * from fts4aux)',
      // `window` 不是关键字时只是别名：后面逗号分隔的仍是表引用。
      'select * from widget_kv window, generate_series(1, 2)',
      'select * from main.widget_kv',
      'select * from temp.widget_kv',
      'select * from "temp"."widget_kv"',
      'select * from "sqlite_""dbpage"',
      // 只折 ASCII 大小写：开尔文符号 K（U+212A）经 Unicode 小写化会变成 k，不能借此冒充视图名。
      'select * from "widget_Kv"',
      'select * from future_vtab',
    ]) {
      expect(tableReferenceViolation(sql), sql).not.toBeNull();
      expect(gate.check(sql), sql).not.toBeNull();
    }
  });
});

describe('WidgetQueryRunner（独立只读子进程 + 物理闸）', () => {
  it('视图按作用域实例化：只看见本组件的 KV 与本对话未撤回的文字消息', async () => {
    const { db, file } = openDb();
    const runner = runnerFor(file);
    await expect(
      runner.run(job("select key, json_extract(value_json, '$.amount') as amount from widget_kv order by key")),
    ).resolves.toEqual({
      rows: [
        { key: 'k1', amount: 3 },
        { key: 'k2', amount: 4 },
      ],
      truncated: false,
    });
    await expect(runner.run(job('select id, text from conversation_messages order by seq'))).resolves.toEqual({
      rows: [{ id: 'm1', text: '你好' }],
      truncated: false,
    });
    // 换作用域（同一子进程）：视图重建，看见的是 wgt_b 的数据。
    await expect(runner.run(job('select key from widget_kv', {}, 'wgt_b'))).resolves.toEqual({
      rows: [{ key: 'secret' }],
      truncated: false,
    });
    closeDatabase(db);
  });

  it('物理闸：绕过名字闸直接读白名单外的表 / 经 main 里的视图读 / 读 schema 都被拒', async () => {
    const { db, file } = openDb();
    // 一个 main 里的视图（模拟 schema 变化或外力植入）：EXPLAIN 时视图展开，读的是 probe_secrets。
    db.exec('create view sneaky as select v from probe_secrets');
    const runner = runnerFor(file);
    for (const sql of [
      'select v from probe_secrets',
      'select v from sneaky',
      'select * from main.sqlite_master',
      'select * from widget_kv, probe_secrets',
      'with x as (select v from probe_secrets) select * from x',
    ]) {
      await expect(runner.run(job(sql)), sql).rejects.toMatchObject({ code: 'WIDGET_QUERY_FAILED' });
    }
    // 白名单表本身不等于能读全量：未加作用域的直接访问在名字闸就被拒（见上），这里只验证
    // 物理闸不是唯一防线也不会误伤合法查询。
    await expect(runner.run(job('select count(*) as n from widget_kv'))).resolves.toEqual({
      rows: [{ n: 2 }],
      truncated: false,
    });
    closeDatabase(db);
  });

  it('写语句 / PRAGMA / ATTACH 在子进程里同样被拒（只读连接 + query_only + 首词白名单）', async () => {
    const { db, file } = openDb();
    const runner = runnerFor(file);
    for (const sql of [
      "delete from messages where id = 'm1'",
      "update widget_docs set value_json = '{}'",
      'pragma query_only = off',
      "attach database ':memory:' as x",
    ]) {
      await expect(runner.run(job(sql)), sql).rejects.toMatchObject({ code: 'WIDGET_QUERY_FAILED' });
    }
    expect(db.prepare('select count(*) as n from messages').get()).toEqual({ n: 3 });
    expect(db.prepare("select value_json from widget_docs where key = 'k1'").get()).toEqual({
      value_json: '{"amount":3}',
    });
    closeDatabase(db);
  });

  it('递归 CTE 死循环：超时杀子进程（WIDGET_QUERY_TIMEOUT），宿主事件循环不被冻结，下一条在新进程里照常跑', async () => {
    const { db, file } = openDb();
    const runner = runnerFor(file, { timeoutMs: 400 });
    // 先热身：子进程已就绪，时限只算执行。
    await runner.run(job('select 1 as one'));
    const firstPid = runner.pid;
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 20);
    const started = Date.now();
    await expect(
      runner.run(job('with recursive c(x) as (select 1 union all select x + 1 from c) select count(*) from c')),
    ).rejects.toMatchObject({ code: 'WIDGET_QUERY_TIMEOUT' });
    clearInterval(ticker);
    expect(Date.now() - started).toBeLessThan(5_000);
    // 宿主在等待期间仍在跑定时器（查询不在宿主线程里执行）。
    expect(ticks).toBeGreaterThan(5);
    await expect(runner.run(job('select 2 as two'))).resolves.toEqual({ rows: [{ two: 2 }], truncated: false });
    expect(runner.pid).not.toBe(firstPid);
    closeDatabase(db);
  });

  it.runIf(process.platform === 'linux')('内存超限：常驻内存超过上限即杀子进程', async () => {
    const { db, file } = openDb();
    const runner = runnerFor(file, { timeoutMs: 20_000, memoryMaxBytes: 96 * 1024 * 1024 });
    await runner.run(job('select 1 as one'));
    await expect(
      runner.run(
        job(
          'with recursive c(x) as (select 1 union all select x + 1 from c limit 40) ' +
            'select length(group_concat(hex(randomblob(10000000)))) as n from c',
        ),
      ),
    ).rejects.toMatchObject({ code: 'WIDGET_QUERY_TIMEOUT', message: expect.stringContaining('内存') });
    closeDatabase(db);
  });

  it('截断判定：恰好 rowsMax 行不算截断，多一行才算', async () => {
    const { db, file } = openDb();
    const insert = db.prepare(
      "insert into widget_docs (widget_id, key, value_json, updated_at) values ('wgt_b', ?, '1', 1)",
    );
    db.transaction(() => {
      // wgt_b 已有 1 个键：补到恰好 200。
      for (let i = 1; i < BOT_WIDGET_QUERY_ROWS_MAX; i += 1) insert.run(`n${String(i).padStart(4, '0')}`);
    })();
    const runner = runnerFor(file);
    const exact = await runner.run(job('select key from widget_kv', {}, 'wgt_b'));
    expect(exact.rows).toHaveLength(BOT_WIDGET_QUERY_ROWS_MAX);
    expect(exact.truncated).toBe(false);
    insert.run('overflow');
    const over = await runner.run(job('select key from widget_kv', {}, 'wgt_b'));
    expect(over.rows).toHaveLength(BOT_WIDGET_QUERY_ROWS_MAX);
    expect(over.truncated).toBe(true);
    closeDatabase(db);
  });

  it('参数：bigint 经 IPC 绑定；缺参数报人话', async () => {
    const { db, file } = openDb();
    const runner = runnerFor(file);
    await expect(runner.run(job('select :id as id', { id: 42n }))).resolves.toEqual({
      rows: [{ id: 42 }],
      truncated: false,
    });
    await expect(runner.run(job('select :month as m'))).rejects.toMatchObject({
      code: 'WIDGET_QUERY_FAILED',
      message: expect.stringContaining('缺少参数「month」'),
    });
    closeDatabase(db);
  });

  it('dispose 后拒绝新查询并杀掉子进程', async () => {
    const { db, file } = openDb();
    const runner = runnerFor(file);
    await runner.run(job('select 1 as one'));
    expect(runner.pid).not.toBeNull();
    runner.dispose();
    await expect(runner.run(job('select 1 as one'))).rejects.toMatchObject({ code: 'WIDGET_QUERY_FAILED' });
    closeDatabase(db);
  });

  // 第二轮审查 D(2)：在途与排队的查询在 dispose 时立即失败，不等子进程的 exit 事件。
  it('dispose：在途与排队的查询立即失败（不等 exit），子进程被杀', async () => {
    const { db, file } = openDb();
    const runner = runnerFor(file, { timeoutMs: 20_000 });
    await runner.run(job('select 1 as one'));
    const pid = runner.pid!;
    const pending = Promise.allSettled([runner.run(job(LOOP)), runner.run(job('select 1 as one', {}, 'wgt_b'))]);
    const started = Date.now();
    runner.dispose();
    const results = await pending;
    expect(Date.now() - started).toBeLessThan(500);
    for (const result of results) {
      expect(result).toMatchObject({
        status: 'rejected',
        reason: { code: 'WIDGET_QUERY_FAILED', message: '执行服务已关闭' },
      });
    }
    expect(runner.pid).toBeNull();
    await waitUntilDead(pid);
    closeDatabase(db);
  });

  // 第二轮审查 D(1)：IPC 发送失败时子进程仍活着——先杀掉再按退出处理，不留孤儿。
  it('IPC 发送失败：杀掉仍存活的子进程、本条失败带原因，下一条在新进程里照常跑', async () => {
    const { db, file } = openDb();
    const runner = runnerFor(file);
    await runner.run(job('select 1 as one'));
    const pid = runner.pid!;
    // 函数不可经 advanced 序列化克隆：send 同步抛错（与异步 'error' 事件走同一处理）。
    const unsendable = job('select :f as f', { f: (() => 1) as unknown as number });
    await expect(runner.run(unsendable)).rejects.toMatchObject({
      code: 'WIDGET_QUERY_FAILED',
      message: expect.stringContaining('执行环境意外退出'),
    });
    await waitUntilDead(pid);
    await expect(runner.run(job('select 2 as two'))).resolves.toEqual({ rows: [{ two: 2 }], truncated: false });
    expect(runner.pid).not.toBe(pid);
    closeDatabase(db);
  });

  // 第二轮审查 B：打包态驱动路径与「执行环境不可用」的可诊断信息。
  it('驱动路径：asar 内路径映射到 app.asar.unpacked（存在才用），否则原样', () => {
    const inAsar = '/opt/KepCup/resources/app.asar/node_modules/better-sqlite3-multiple-ciphers/lib/index.js';
    const unpacked = '/opt/KepCup/resources/app.asar.unpacked/node_modules/better-sqlite3-multiple-ciphers/lib/index.js';
    expect(resolveQueryDriverPath(() => inAsar, (file) => file === unpacked)).toBe(unpacked);
    expect(resolveQueryDriverPath(() => inAsar, () => false)).toBe(inAsar);
    const winAsar = 'C:\\KepCup\\resources\\app.asar\\node_modules\\better-sqlite3-multiple-ciphers\\lib\\index.js';
    expect(resolveQueryDriverPath(() => winAsar, () => true)).toBe(
      'C:\\KepCup\\resources\\app.asar.unpacked\\node_modules\\better-sqlite3-multiple-ciphers\\lib\\index.js',
    );
    const plain = '/repo/node_modules/better-sqlite3-multiple-ciphers/lib/index.js';
    expect(resolveQueryDriverPath(() => plain, () => true)).toBe(plain);
    expect(resolveQueryDriverPath()).toMatch(/better-sqlite3-multiple-ciphers/);
  });

  it('驱动加载失败：明确的「执行环境不可用」，带驱动路径与子进程运行时，并写诊断日志', async () => {
    const { db, file } = openDb();
    const warnings: Array<Record<string, unknown>> = [];
    const missing = path.join(dir, 'missing-driver.js');
    const runner = runnerFor(file, { driverPath: missing, logger: { warn: (fields) => warnings.push(fields) } });
    const error = await runner.run(job('select 1 as one')).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'WIDGET_QUERY_FAILED' });
    const message = (error as Error).message;
    expect(message).toContain('执行环境不可用');
    expect(message).toContain(missing);
    expect(message).toMatch(/子进程 node \d+/);
    expect(warnings).toEqual([expect.objectContaining({ modulePath: missing })]);
    closeDatabase(db);
  });
});

/** 卡在原生 sqlite3_step 里的查询（只能靠杀进程止损）。 */
const LOOP = 'with recursive c(x) as (select 1 union all select x + 1 from c) select count(*) from c';

async function waitUntilDead(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error(`子进程 ${pid} 没有退出`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// 第二轮审查 A：子进程是共用的串行资源——按组件分桶轮转、每组件限额、连续超时熔断。
describe('WidgetQueryRunner 公平性（按组件分桶 / 限额 / 熔断）', () => {
  it('轮转：一个组件排满死循环查询，别的组件的查询在它的下一条之前执行', async () => {
    const { db, file } = openDb();
    const runner = runnerFor(file, { timeoutMs: 300, breakerStrikes: 100 });
    await runner.run(job('select 1 as one'));
    const order: string[] = [];
    const track = (label: string, promise: Promise<unknown>): Promise<unknown> =>
      promise.then(
        () => order.push(label),
        () => order.push(label),
      );
    const all = Promise.all([
      track('a1', runner.run(job(LOOP))),
      track('a2', runner.run(job(LOOP))),
      track('a3', runner.run(job(LOOP))),
      track('b', runner.run(job('select key from widget_kv', {}, 'wgt_b'))),
    ]);
    await all;
    // 旧实现是全局 FIFO：a1 a2 a3 b（b 要等三个时限 + 三次重起进程）。
    expect(order).toEqual(['a1', 'b', 'a2', 'a3']);
    closeDatabase(db);
  });

  it('每组件限额：超出立即 WIDGET_RATE_LIMITED（带上限说明），别的组件不受影响', async () => {
    const { db, file } = openDb();
    const runner = runnerFor(file, { timeoutMs: 300, perOwnerMax: 2, breakerStrikes: 100 });
    await runner.run(job('select 1 as one'));
    const mine = Promise.allSettled([runner.run(job(LOOP)), runner.run(job(LOOP))]);
    await expect(runner.run(job('select 1 as one'))).rejects.toMatchObject({
      code: 'WIDGET_RATE_LIMITED',
      message: expect.stringContaining('已达 2 条'),
    });
    await expect(runner.run(job('select key from widget_kv', {}, 'wgt_b'))).resolves.toEqual({
      rows: [{ key: 'secret' }],
      truncated: false,
    });
    expect((await mine).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    closeDatabase(db);
  });

  it('熔断：连续超时达到阈值后排队的立即失败、冷却期内拒绝；别的组件照常；冷却后半开、成功才清零', async () => {
    const { db, file } = openDb();
    let now = 1_000_000;
    const runner = runnerFor(file, {
      timeoutMs: 300,
      breakerStrikes: 2,
      breakerCooldownMs: 10_000,
      now: () => now,
    });
    await runner.run(job('select 1 as one'));
    const started = Date.now();
    const results = await Promise.allSettled([
      runner.run(job(LOOP)),
      runner.run(job(LOOP)),
      runner.run(job(LOOP)),
      runner.run(job(LOOP)),
    ]);
    expect(results.map((result) => (result.status === 'rejected' ? (result.reason as { code: string }).code : 'ok'))).toEqual([
      'WIDGET_QUERY_TIMEOUT',
      'WIDGET_QUERY_TIMEOUT',
      'WIDGET_RATE_LIMITED',
      'WIDGET_RATE_LIMITED',
    ]);
    // 第三、四条没有再各占一个时限。
    expect(Date.now() - started).toBeLessThan(2_500);
    expect((results[2] as PromiseRejectedResult).reason.message).toContain('连续超时');
    await expect(runner.run(job('select 1 as one'))).rejects.toMatchObject({ code: 'WIDGET_RATE_LIMITED' });
    await expect(runner.run(job('select key from widget_kv', {}, 'wgt_b'))).resolves.toMatchObject({
      rows: [{ key: 'secret' }],
    });
    // 冷却结束：半开——再超时一次立即重新熔断。
    now += 10_001;
    await expect(runner.run(job(LOOP))).rejects.toMatchObject({ code: 'WIDGET_QUERY_TIMEOUT' });
    await expect(runner.run(job('select 1 as one'))).rejects.toMatchObject({ code: 'WIDGET_RATE_LIMITED' });
    // 再冷却后成功一次：清零，单次超时不再熔断。
    now += 10_001;
    await expect(runner.run(job('select 1 as one'))).resolves.toEqual({ rows: [{ one: 1 }], truncated: false });
    await expect(runner.run(job(LOOP))).rejects.toMatchObject({ code: 'WIDGET_QUERY_TIMEOUT' });
    await expect(runner.run(job('select 1 as one'))).resolves.toEqual({ rows: [{ one: 1 }], truncated: false });
    closeDatabase(db);
  });
});
