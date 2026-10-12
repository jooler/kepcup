import {
  AppError,
  BOT_WIDGET_QUERIES_MAX,
  BOT_WIDGET_QUERY_SQL_MAX_BYTES,
  widgetQueryDefSchema,
  type WidgetQueryDef,
} from '@kepcup/shared';

/** The slice of {@link WidgetQueryGate} the validation needs (null = allowed). */
export interface WidgetQueryNameGate {
  check(sql: string): string | null;
}

/**
 * 交付侧的查询模板校验（`WidgetService.create` / `update` 落库前，与制作 loop 检查器的
 * `query.invalid` 共用同一份代码，设计 32 §11.8.1）：形状 / 数量 / 名字唯一 / 体积，再逐条过
 * 名字闸（query-gate.ts：只读 + 只能引用作用域视图）——语法错误、越界的表、写语句在交付时
 * 即被拒绝（Bot 拿到可行动的错误，用户也不会看到注定跑不通的模板）。失败抛 `INVALID_INPUT`。
 */
export function cleanWidgetQueries(
  raw: WidgetQueryDef[] | undefined,
  gate: WidgetQueryNameGate,
): WidgetQueryDef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new AppError('INVALID_INPUT', 'queries 必须是模板数组');
  }
  if (raw.length > BOT_WIDGET_QUERIES_MAX) {
    throw new AppError('INVALID_INPUT', `查询模板最多 ${BOT_WIDGET_QUERIES_MAX} 条`);
  }
  const seen = new Set<string>();
  return raw.map((def) => {
    const parsed = widgetQueryDefSchema.safeParse(def);
    if (!parsed.success) {
      throw new AppError(
        'INVALID_INPUT',
        '查询模板不合法：name 需为 1–64 个字母/数字/-/_，sql 不能为空且 ≤64KB',
      );
    }
    const { name, sql } = parsed.data;
    if (seen.has(name)) throw new AppError('INVALID_INPUT', `查询模板名重复：${name}`);
    seen.add(name);
    if (Buffer.byteLength(sql) > BOT_WIDGET_QUERY_SQL_MAX_BYTES) {
      throw new AppError(
        'INVALID_INPUT',
        `查询「${name}」的 SQL 过大（上限 ${BOT_WIDGET_QUERY_SQL_MAX_BYTES} 字节）`,
      );
    }
    // __proto__ 作为命名参数永远绑不上（对象键赋值是原型操作不是 own key），人审
    // 会放行一个运行时必败的模板——交付时即拒，让 Bot 改名。
    if (/[:@?$]__proto__\b/i.test(sql)) {
      throw new AppError(
        'INVALID_INPUT',
        `查询「${name}」的参数名不能是 __proto__（保留字，参数绑定会静默失败），请换一个名字`,
      );
    }
    const denied = gate.check(sql);
    if (denied !== null) throw new AppError('INVALID_INPUT', `查询「${name}」${denied}`);
    return parsed.data;
  });
}
