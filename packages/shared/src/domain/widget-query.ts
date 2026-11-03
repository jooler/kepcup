import { z } from 'zod';

/**
 * 命名只读查询模板定义（叶子模块）：`widget_create` / `widget_update` 与微应用清单
 * `micro-app.json` 的 `queries` 共用。单独成文件是为打断 `widgets-ui.ts` ↔ `micro-app.ts`
 * 的导入环（两边都要引用这份 schema）。
 */

/** 每个版本最多登记的查询模板数（组件与微应用同限）。 */
export const BOT_WIDGET_QUERIES_MAX = 20;
/** 查询模板名的长度上限（字符集约束见 `widgetQueryDefSchema`）。 */
export const BOT_WIDGET_QUERY_NAME_MAX_CHARS = 64;
/** 单条查询模板 SQL 的体积上限（字节；zod 侧按 UTF-16 粗检，字节精检在 core）。 */
export const BOT_WIDGET_QUERY_SQL_MAX_BYTES = 64 * 1024;

/**
 * 命名只读查询模板定义。模板随版本登记（版本 = HTML + 查询的完整快照，只增不改）：
 * SQL 在交付时被用户人工预审（审查态「查看源码」可见全文），运行时只能按名字调用，
 * 输入只有参数、没有 SQL——这是 query 免审批的唯一理由（运行时 raw SQL 透传永久不做）。
 */
// 注意：查询定义**不是** strict——`widget-check-run.test.ts` 锁住了「多余键静默剥离」的
// 规范化语义（canonical {name, sql}）。与微应用清单（strict）有意不同。
export const widgetQueryDefSchema = z.object({
  /** 组件内 `kepcup.query(name, params)` 的名字。 */
  name: z
    .string()
    .min(1)
    .max(BOT_WIDGET_QUERY_NAME_MAX_CHARS)
    .regex(/^[A-Za-z0-9_-]+$/, '查询名只能含字母、数字、- 和 _'),
  /** 单条只读 SQL（SELECT / WITH…SELECT），`:name` 占位参数；多语句与非只读在 core 拒绝。 */
  sql: z.string().min(1).max(BOT_WIDGET_QUERY_SQL_MAX_BYTES),
});
export type WidgetQueryDef = z.infer<typeof widgetQueryDefSchema>;
