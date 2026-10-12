import Database from 'better-sqlite3-multiple-ciphers';
import type { SqliteDatabase } from '../infra/db.js';

/**
 * 组件查询模板的数据范围（D81 审查修复，设计 32 §6.1）。
 *
 * 模板 SQL 不能碰 main.db 的任意表：它只看得见两张**作用域视图**——查询子进程每次
 * 执行前在 temp schema 里按卡片的 widgetId / conversationId 现建（字面量内联），
 * 视图名刻意不与 main 的任何表重名：视图缺失时 SQL 得「no such table」，而不是
 * 静默落到同名的物理表上读全量（fail closed）。
 *
 * 两道相互独立的闸：
 *
 * 1. **名字闸**（{@link WidgetQueryGate.check}，core 进程内，交付时与每次运行前各跑一次）：
 *    先做表引用位置的**白名单**（{@link tableReferenceViolation}：FROM / JOIN / 逗号 /
 *    IN 位置只能是作用域视图、json_each / json_tree、作用域内的 CTE）——eponymous 虚表
 *    （pragma_*、dbstat、sqlite_dbpage…）在任何库里都编译得过，且虚表的 VOpen 在
 *    EXPLAIN 里只有指针、物理闸的 OpenRead 核对对它无效，只能在名字层按白名单拦；
 *    再在一个只有这两张视图同名同列「桩表」（建在 temp schema、main 为空）的内存库里
 *    编译模板——`main.x` / 任何别的表 / attach 的库都「no such table」；最后查
 *    `EXPLAIN`：只允许在桩表上 OpenRead，读 sqlite_schema / sqlite_temp_schema、任何
 *    写操作码一律拒绝。
 * 2. **物理闸**（查询子进程，见 query-runner.ts）：在真实只读连接上建好视图后对模板
 *    `EXPLAIN`，把每个 OpenRead 的 rootpage 经 sqlite_schema 映射回表名，必须落在
 *    视图背后的物理表白名单（{@link WIDGET_QUERY_PHYSICAL_TABLES}）里——视图在
 *    编译期展开，CTE / 子查询 / 视图套视图读到的每张表都会出现在程序里。
 *
 * 行级范围（只读本组件 / 本对话的行）由视图定义保证；名字闸保证模板只能经视图访问。
 */

export interface WidgetQueryScope {
  widgetId: string;
  conversationId: string;
}

interface WidgetQueryView {
  /** 模板里可引用的名字（temp schema 中的视图）。 */
  name: string;
  /** 列（桩表与视图同列同序）。 */
  columns: readonly string[];
  /** 视图定义（只引用 `main.` 下的物理表；作用域 id 以 SQL 字面量内联）。 */
  select(scope: WidgetQueryScope): string;
}

/** SQL 字符串字面量（单引号转义）。 */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export const WIDGET_QUERY_VIEWS: readonly WidgetQueryView[] = [
  {
    // 本组件 storage 的数据（value_json 是 JSON 文本，用 json_extract 取字段）。
    name: 'widget_kv',
    columns: ['key', 'value_json', 'updated_at'],
    select: (scope) =>
      `select key, value_json, updated_at from main.widget_docs where widget_id = ${literal(scope.widgetId)}`,
  },
  {
    // 卡片所在对话的文字消息（不含已撤回；不暴露 content_json 里的附件 / 卡片等结构）。
    name: 'conversation_messages',
    columns: ['id', 'seq', 'sender_type', 'sender_bot_id', 'text', 'created_at'],
    select: (scope) =>
      'select id, seq, sender_type, sender_bot_id, ' +
      "json_extract(content_json, '$.text') as text, created_at from main.messages " +
      `where conversation_id = ${literal(scope.conversationId)} and kind = 'text' and status <> 'recalled'`,
  },
];

/** 工具说明里给 Bot 的数据范围说明（与 {@link WIDGET_QUERY_VIEWS} 同步）。 */
export const WIDGET_QUERY_SCOPE_GUIDE =
  '查询模板只能读两张视图（其他表、库结构、pragma_* 一律不可读；表值函数只能用 json_each / json_tree；' +
  '表名不能带库名前缀）：' +
  'widget_kv(key, value_json, updated_at)——本组件 storage 里存的数据（value_json 是 JSON 文本，' +
  "用 json_extract(value_json, '$.字段') 取值，可配合 json_each 展开数组）；" +
  'conversation_messages(id, seq, sender_type, sender_bot_id, text, created_at)——卡片所在对话的文字消息' +
  '（不含已撤回，sender_type 为 user/bot/system）。';

/** 视图背后允许读取的物理表（物理闸的白名单；不含 secrets / 连接凭据等任何别的表）。 */
export const WIDGET_QUERY_PHYSICAL_TABLES: readonly string[] = ['widget_docs', 'messages'];

/** 交付给查询子进程的视图定义（按作用域实例化）。 */
export function widgetQueryViewsFor(scope: WidgetQueryScope): Array<{ name: string; select: string }> {
  return WIDGET_QUERY_VIEWS.map((view) => ({ name: view.name, select: view.select(scope) }));
}

/**
 * 写库 / 改 schema / 改连接状态的操作码：只读语句本不该出现，出现即拒（两道闸共用）。
 * OpenRead 的 rootpage 与库号另行核对。
 */
export const WIDGET_QUERY_DENIED_OPCODES: ReadonlySet<string> = new Set([
  'OpenWrite',
  'VUpdate',
  'VCreate',
  'VDestroy',
  'VBegin',
  'ParseSchema',
  'SqlExec',
  'Vacuum',
  'Destroy',
  'Clear',
  'CreateBtree',
  'DropTable',
  'DropIndex',
  'DropTrigger',
  'IntegrityCk',
  'JournalMode',
  'Program',
]);

/**
 * 查询模板的首关键词白名单：只放行 SELECT / WITH（WITH…INSERT/UPDATE/DELETE 由
 * `stmt.readonly` 拦）。单独需要它是因为 sqlite3_stmt_readonly 对 PRAGMA / ATTACH
 * 也返回 true。跳过前导空白与 SQL 注释后比对首词。
 */
export function isReadOnlySelectSql(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trimStart();
  return /^(select|with)\b/i.test(stripped);
}

/**
 * SQL 词法单元（与 SQLite 分词器同口径的子集，供名字闸分析）：
 * - `word`：裸词（标识符或关键字，ASCII 小写化——SQLite 只对 ASCII 做大小写折叠，
 *   这里也只折 ASCII，避免 `K`（U+212A）之类经 Unicode 小写化后伪装成白名单名字）；
 * - `quoted`：`"…"` / `` `…` `` / `[…]` 引用标识符（同样只折 ASCII；SQLite 编译时
 *   关闭了双引号字符串 SQLITE_DQS=0，"…" 恒为标识符）；
 * - `param`：命名参数（`:x` / `@x` / `$x`，text 为去前缀的原名）或 `?` / `?NNN`；
 * - `punct`：`(` `)` `,` `.` `;`。
 * 字符串字面量、注释、数字与其余运算符不产出单元（它们不可能是表名）。
 */
export interface SqlToken {
  kind: 'word' | 'quoted' | 'param' | 'punct';
  text: string;
}

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  const n = sql.length;
  const isStart = (c: string): boolean => /[A-Za-z_\u0080-￿]/.test(c);
  const isPart = (c: string): boolean => /[A-Za-z0-9_$\u0080-￿]/.test(c);
  while (i < n) {
    const c = sql[i]!;
    if (c === "'") {
      i += 1;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          break;
        }
        i += 1;
      }
      i += 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i += 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === '"' || c === '`') {
      let text = '';
      i += 1;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            text += c;
            i += 2;
            continue;
          }
          break;
        }
        text += sql[i];
        i += 1;
      }
      i += 1;
      tokens.push({ kind: 'quoted', text: asciiLower(text) });
    } else if (c === '[') {
      const end = sql.indexOf(']', i + 1);
      tokens.push({ kind: 'quoted', text: asciiLower(sql.slice(i + 1, end === -1 ? n : end)) });
      i = end === -1 ? n : end + 1;
    } else if ((c === ':' || c === '@' || c === '$') && i + 1 < n && isPart(sql[i + 1]!)) {
      let j = i + 1;
      while (j < n && isPart(sql[j]!)) j += 1;
      tokens.push({ kind: 'param', text: sql.slice(i, j) });
      i = j;
    } else if (c === '?') {
      let j = i + 1;
      while (j < n && /[0-9]/.test(sql[j]!)) j += 1;
      tokens.push({ kind: 'param', text: sql.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(c)) {
      // 数字字面量（含 1e5 / 0x1f 之类的尾随字母）整体跳过，不产出单元。
      let j = i + 1;
      while (j < n && isPart(sql[j]!)) j += 1;
      i = j;
    } else if (isStart(c)) {
      let j = i + 1;
      while (j < n && isPart(sql[j]!)) j += 1;
      tokens.push({ kind: 'word', text: asciiLower(sql.slice(i, j)) });
      i = j;
    } else {
      if (c === '(' || c === ')' || c === ',' || c === '.' || c === ';') tokens.push({ kind: 'punct', text: c });
      i += 1;
    }
  }
  return tokens;
}

interface SqlScan {
  /** 标识符（裸词与 "…" / `…` / […] 引用标识符，ASCII 小写）。 */
  identifiers: string[];
  /** 命名参数（:x / @x / $x，better-sqlite3 按不带前缀的名字绑定）。 */
  named: string[];
  /** 匿名 / 编号参数（? / ?NNN）需要的位置参数个数。 */
  positional: number;
}

/** 粗粒度的 SQL 词法扫描：收集标识符与参数占位（字符串字面量与注释里的不算）。 */
export function scanSql(sql: string): SqlScan {
  const identifiers: string[] = [];
  const named = new Set<string>();
  let anonymous = 0;
  let maxNumbered = 0;
  for (const token of tokenizeSql(sql)) {
    if (token.kind === 'word' || token.kind === 'quoted') {
      identifiers.push(token.text);
    } else if (token.kind === 'param') {
      if (token.text.startsWith('?')) {
        if (token.text.length > 1) maxNumbered = Math.max(maxNumbered, Number(token.text.slice(1)));
        else anonymous += 1;
      } else {
        named.add(token.text.slice(1));
      }
    }
  }
  return { identifiers, named: [...named], positional: Math.max(anonymous, maxNumbered) };
}

/** SQL 里出现的标识符（ASCII 小写；见 {@link scanSql}）。 */
export function sqlIdentifiers(sql: string): string[] {
  return scanSql(sql).identifiers;
}

/**
 * `EXPLAIN` 只编译不执行，但 better-sqlite3 仍要求把每个参数都绑上：用 null 占位
 * 生成绑定参数（位置参数在前、命名参数对象在后）。
 */
export function explainBindings(sql: string): unknown[] {
  const { named, positional } = scanSql(sql);
  const args: unknown[] = Array.from({ length: positional }, () => null);
  if (named.length > 0) args.push(Object.fromEntries(named.map((name) => [name, null])));
  return args;
}

/**
 * 表值函数白名单：只放行 JSON 展开（读的只是参数本身）。其余 eponymous 虚表——
 * `pragma_*`（schema / 连接信息）、`dbstat`（页级统计）、`sqlite_dbpage`（原始页，
 * 加密库下是**解密后**的页）、`sqlite_stmt`、`generate_series` 等——一律拒绝，
 * 包括将来编译选项变化后才出现的模块（白名单，不是黑名单）。
 */
export const WIDGET_QUERY_TABLE_FUNCTIONS: readonly string[] = ['json_each', 'json_tree'];

/**
 * 已知危险名（纵深防御）：在任何位置出现都拒绝——即便表位置分析
 * （{@link tableReferenceViolation}）因语法变体漏判，这几类名字也到不了编译。
 */
function deniedIdentifier(sql: string): string | null {
  for (const id of sqlIdentifiers(sql)) {
    if (id.startsWith('pragma_') || id === 'dbstat' || id === 'sqlite_dbpage' || id === 'sqlite_stmt') return id;
  }
  return null;
}

/** 结束当前层 FROM 子句的保留字（均不是 SQLite 的 fallback 关键字，不能当标识符用）。 */
const FROM_TERMINATORS = new Set(['where', 'group', 'having', 'order', 'limit', 'union', 'intersect', 'except']);

interface RefFrame {
  /** 当前括号层处在 FROM 子句（含 JOIN 约束）里：本层逗号分隔的是表引用。 */
  inFrom: boolean;
  /** 当前层处在 WITH 子句里：本层逗号分隔的是 CTE 定义。 */
  inWith: boolean;
  /**
   * 下一个单元的角色：表引用（FROM / JOIN / 逗号之后；后跟括号 = 括号分组的 join 或
   * 子查询）、`IN` 之后（标识符 = 表引用；后跟括号 = 值列表或子查询）、CTE 名（WITH / 逗号之后）。
   */
  expect: 'table' | 'in' | 'cte' | null;
  /** 本层 WITH 声明的 CTE 名（对本层及内层可见；本层括号闭合即出作用域）。 */
  ctes: Set<string>;
}

/**
 * 名字层**白名单**：每个处在「表引用位置」的标识符（`FROM` / `JOIN` / FROM 子句里的
 * 逗号 / `IN` 之后，含括号分组的 join 与表值函数调用）必须是作用域视图、
 * {@link WIDGET_QUERY_TABLE_FUNCTIONS} 或在作用域内声明过的 CTE；带库名前缀
 * （`main.x` / `temp.x`）一律拒绝。CTE 名按括号层跟踪作用域：内层子查询声明的
 * CTE 在外层不可见（防 `(with dbstat as … ) , dbstat` 借名），先引用后声明同样拒绝。
 * 分析偏保守：认不出的写法只会多拒（如 WINDOW 子句以外把软关键字当表名），不会漏放。
 * 违规返回人话原因，通过返回 null。
 */
export function tableReferenceViolation(sql: string): string | null {
  const tokens = tokenizeSql(sql);
  const allowed = new Set([...WIDGET_QUERY_VIEWS.map((view) => view.name), ...WIDGET_QUERY_TABLE_FUNCTIONS]);
  const stack: RefFrame[] = [{ inFrom: false, inWith: false, expect: null, ctes: new Set() }];
  const isWord = (index: number, text: string): boolean =>
    tokens[index]?.kind === 'word' && tokens[index]!.text === text;
  const isName = (index: number): boolean => tokens[index]?.kind === 'word' || tokens[index]?.kind === 'quoted';
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const frame = stack[stack.length - 1]!;
    if (token.kind === 'punct') {
      if (token.text === '(') {
        // FROM / JOIN 后紧跟括号：括号分组的 join（首个标识符就是表引用）或子查询
        // （首词 SELECT / WITH / VALUES 时改判为子查询）。
        const opensTable = frame.expect === 'table';
        frame.expect = null;
        stack.push({ inFrom: opensTable, inWith: false, expect: opensTable ? 'table' : null, ctes: new Set() });
      } else if (token.text === ')') {
        if (stack.length > 1) stack.pop();
      } else if (token.text === ',') {
        if (frame.inWith) frame.expect = 'cte';
        else if (frame.inFrom) frame.expect = 'table';
        else frame.expect = null;
      } else {
        frame.expect = null;
      }
      continue;
    }
    if (token.kind === 'param') {
      frame.expect = null;
      continue;
    }
    const keyword = token.kind === 'word' ? token.text : null;
    if (keyword === 'select' || keyword === 'values') {
      frame.inWith = false;
      frame.inFrom = false;
      frame.expect = null;
      continue;
    }
    if (keyword === 'with') {
      frame.inFrom = false;
      frame.inWith = true;
      frame.expect = 'cte';
      continue;
    }
    if (frame.expect === 'cte') {
      if (keyword === 'recursive') continue;
      frame.ctes.add(token.text);
      frame.expect = null;
      continue;
    }
    if (frame.expect === 'table' || frame.expect === 'in') {
      frame.expect = null;
      if (tokens[index + 1]?.kind === 'punct' && tokens[index + 1]!.text === '.') {
        const qualified = isName(index + 2) ? `${token.text}.${tokens[index + 2]!.text}` : token.text;
        return `不能带库名前缀引用「${qualified}」`;
      }
      if (!allowed.has(token.text) && !stack.some((f) => f.ctes.has(token.text))) {
        return `不能读取「${token.text}」`;
      }
      continue;
    }
    if (keyword === null) continue;
    if (keyword === 'from') {
      // `a IS [NOT] DISTINCT FROM b` 是比较运算符，不是 FROM 子句。
      const operator = isWord(index - 1, 'distinct') && (isWord(index - 2, 'is') || isWord(index - 2, 'not'));
      if (!operator) {
        frame.inFrom = true;
        frame.expect = 'table';
      }
    } else if (keyword === 'join') {
      frame.inFrom = true;
      frame.expect = 'table';
    } else if (keyword === 'in') {
      // `expr IN 表名` / `expr IN 表值函数(…)`：后面是标识符即表引用；是括号则是列表 / 子查询。
      frame.expect = 'in';
    } else if (FROM_TERMINATORS.has(keyword)) {
      frame.inFrom = false;
    } else if (keyword === 'window' && isName(index + 1) && isWord(index + 2, 'as')) {
      // SQLite 只在 `WINDOW 名字 AS` 时把 window 当关键字（否则它是普通标识符）。
      frame.inFrom = false;
    }
  }
  return null;
}

interface ExplainRow {
  opcode: string;
  p1: number;
  p2: number;
  p3: number;
  p5: number;
}

/**
 * 名字闸（见模块注释）。返回拒绝原因（人话，调用方包成交付期 INVALID_INPUT 或运行期
 * WIDGET_QUERY_FAILED），通过返回 null。桩库是纯内存的空库：编译不执行，没有可读数据。
 */
export class WidgetQueryGate {
  #stub: SqliteDatabase | null = null;
  #stubRootpages = new Set<number>();

  check(sql: string): string | null {
    if (!isReadOnlySelectSql(sql)) {
      return '必须是单条只读 SELECT（或 WITH…SELECT）——不能写库，也不能是 PRAGMA / ATTACH 等改连接状态的语句';
    }
    const denied = deniedIdentifier(sql);
    if (denied !== null) {
      return `不能使用「${denied}」（查询只能读 ${viewList()}）`;
    }
    const reference = tableReferenceViolation(sql);
    if (reference !== null) {
      return `${reference}（查询只能读 ${viewList()}，表值函数只允许 ${WIDGET_QUERY_TABLE_FUNCTIONS.join(' / ')}）`;
    }
    const stub = this.#stubDb();
    let statement: ReturnType<SqliteDatabase['prepare']>;
    try {
      statement = stub.prepare(sql);
    } catch (error) {
      return `无法编译：${errorMessage(error)}（查询只能读 ${viewList()}，参数用 :名字 占位）`;
    }
    if (statement.readonly !== true) {
      return '必须是单条只读 SELECT（或 WITH…SELECT）——不能写库';
    }
    let program: ExplainRow[];
    try {
      program = stub.prepare(`explain ${sql}`).all(...explainBindings(sql)) as ExplainRow[];
    } catch (error) {
      return `无法编译：${errorMessage(error)}`;
    }
    for (const op of program) {
      if (WIDGET_QUERY_DENIED_OPCODES.has(op.opcode)) {
        return `含有不允许的操作（${op.opcode}）——查询只能读数据`;
      }
      if (op.opcode === 'OpenRead' || op.opcode === 'ReopenIdx') {
        // 桩表都在 temp（库号 1）；读 main（库号 0，必是 sqlite_schema）或
        // sqlite_temp_schema（rootpage 1）都是越界。
        if (op.p3 !== 1 || !this.#stubRootpages.has(op.p2)) {
          return `只能读 ${viewList()}，不能读库结构或其他表`;
        }
      }
    }
    return null;
  }

  dispose(): void {
    this.#stub?.close();
    this.#stub = null;
  }

  #stubDb(): SqliteDatabase {
    if (this.#stub !== null) return this.#stub;
    const stub = new Database(':memory:');
    for (const view of WIDGET_QUERY_VIEWS) {
      stub.exec(`create temp table "${view.name}" (${view.columns.map((c) => `"${c}"`).join(', ')})`);
    }
    const rows = stub.prepare("select rootpage from sqlite_temp_schema where type = 'table'").all() as Array<{
      rootpage: number;
    }>;
    this.#stubRootpages = new Set(rows.map((row) => row.rootpage));
    this.#stub = stub;
    return stub;
  }
}

/** 给 Bot / 用户看的数据范围清单。 */
export function viewList(): string {
  return WIDGET_QUERY_VIEWS.map((view) => `${view.name}(${view.columns.join(', ')})`).join(' 与 ');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
