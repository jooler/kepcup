/**
 * 三方合并（D89 审查修复：设置页过期的整表单保存不再覆盖 Bot 直改 / 设置卡 / 别处刚做的修改）。
 *
 * `settings.update` / `bots.update` 都是整份快照保存：表单从某一版快照（`base`）出发改了几个
 * 字段，提交的是整份（`mine`）。core 在写之前拿最新值（`theirs`）合并：
 *
 * - 表单没改的字段（`mine` 与 `base` 相同）→ 用最新值，别处的并发修改不被旧快照覆盖；
 * - 只有表单改了（`theirs` 与 `base` 相同）→ 用表单的值；
 * - 两边都是普通对象 → 逐键递归；两边都是「按 id 寻址的对象数组」（`mcpServers`、
 *   `customProviders`、`browserProfiles`……）→ 按 id 逐条合并，别处新增的条目保留、别处删掉而
 *   表单没碰的条目不复活；
 * - 两边都改了同一个叶子 → 以这次保存为准（用户刚在表单上亲手改的值）。
 *
 * 没有 `base` 的调用方（老路径、主进程）行为不变：整份覆盖。
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 只读自有键：设置里有以用户输入为键的记录（智能体 id、工具名、环境变量名……），`__proto__` /
 * `constructor` 这类键不能从原型链上读到东西。写出一律走 `Object.fromEntries`（建自有属性，
 * 不会改原型）。
 */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** 结构相等（与键顺序无关；`undefined` 键视同缺省）。 */
export function settingsDeepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((entry, index) => settingsDeepEqual(entry, b[index]))
    );
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (!settingsDeepEqual(own(a, key), own(b, key))) return false;
  }
  return true;
}

type IdEntry = Record<string, unknown> & { id: string };

/** 每一项都是带唯一字符串 `id` 的普通对象（空数组也算）。 */
function idKeyed(value: unknown): value is IdEntry[] {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isPlainObject(entry) || typeof entry.id !== 'string' || seen.has(entry.id)) return false;
    seen.add(entry.id);
  }
  return true;
}

function mergeById(base: IdEntry[], mine: IdEntry[], theirs: IdEntry[]): IdEntry[] {
  const baseById = new Map(base.map((entry) => [entry.id, entry]));
  const theirsById = new Map(theirs.map((entry) => [entry.id, entry]));
  const mineIds = new Set(mine.map((entry) => entry.id));
  const out: IdEntry[] = [];
  for (const entry of mine) {
    const before = baseById.get(entry.id);
    const latest = theirsById.get(entry.id);
    if (before === undefined) {
      out.push(entry);
    } else if (latest === undefined) {
      // 别处删掉了：表单没碰过就跟着删，表单改过就保留（用户刚编辑的条目）。
      if (!settingsDeepEqual(entry, before)) out.push(entry);
    } else {
      out.push(mergeThreeWay(before, entry, latest) as IdEntry);
    }
  }
  for (const entry of theirs) {
    // 别处新增（快照里没有、表单里也没有）→ 保留；快照里有而表单里没有 = 表单删掉的。
    if (!mineIds.has(entry.id) && !baseById.has(entry.id)) out.push(entry);
  }
  return out;
}

export function mergeThreeWay(base: unknown, mine: unknown, theirs: unknown): unknown {
  if (settingsDeepEqual(mine, base)) return theirs;
  if (settingsDeepEqual(theirs, base)) return mine;
  if (settingsDeepEqual(mine, theirs)) return mine;
  if (isPlainObject(base) && isPlainObject(mine) && isPlainObject(theirs)) {
    const entries: Array<[string, unknown]> = [];
    for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
      const value = mergeThreeWay(own(base, key), own(mine, key), own(theirs, key));
      if (value !== undefined) entries.push([key, value]);
    }
    return Object.fromEntries(entries);
  }
  if (idKeyed(base) && idKeyed(mine) && idKeyed(theirs)) return mergeById(base, mine, theirs);
  return mine;
}

/**
 * 整份补丁按 `base` 与最新值逐顶层键三方合并：`base` 里有的键才合并，没有的键按补丁原样
 * （老行为）。返回新的补丁对象，不改入参。
 */
export function mergePatchOnto<T extends Record<string, unknown>>(
  patch: T,
  base: Readonly<Record<string, unknown>> | undefined,
  latest: Readonly<Record<string, unknown>>,
): T {
  if (base === undefined) return patch;
  return Object.fromEntries(
    Object.keys(patch).map((key) => [
      key,
      Object.hasOwn(base, key)
        ? mergeThreeWay(own(base, key), own(patch, key), own(latest, key))
        : own(patch, key),
    ]),
  ) as T;
}
