import type { TeamWorkdirOption } from '@kepcup/shared';
import type { SourceId } from '$lib/rpc/connections.svelte';
import { teamBots } from './team-bots.svelte';

/**
 * TeamWorkdirPicker 的表单逻辑（member-bots B4 子域 A；2026-11 工作路径重构）：
 * `team.bots.workdirOptions` 拉取 opaque 选项（`admin:<wrtId>` 预置根 / `member:
 * <rel>` 本人子树目录，服务器真实路径不出服务端）+ 分组（预置根平铺 / 我的
 * 目录按 parentKey 组树）+ `team.bots.workdirMkdir` 在子树内新建目录。不做
 * 自由路径输入——成员永不浏览任意 FS；越界（WORKDIR_NOT_ALLOWED）与非法目录
 * 名（INVALID_INPUT）以错误码呈现。
 */

export interface WorkdirGroups {
  admin: TeamWorkdirOption[];
  /** 本人子树（按 parentKey 组树；children 为空数组的节点渲染为叶子）。 */
  member: MemberWorkdirNode[];
}

export interface MemberWorkdirNode {
  option: TeamWorkdirOption;
  children: MemberWorkdirNode[];
}

/**
 * 纯分组（2026-11）：admin 预置根平铺在前，member 子树按 parentKey 组树在后，
 * 各自按 name / key 排序稳定。parentKey 缺失（旧服务端）或指向不存在节点的
 * member 选项挂到顶层；挂接成环的边按防御深度剪断（环节点回挂顶层，环下
 * 子树保持挂载）——服务端契约不产环，此处只保证目录不无声消失、组树不死循环。
 */
export function groupWorkdirOptions(options: readonly TeamWorkdirOption[]): WorkdirGroups {
  const admin = options
    .filter((option) => option.source === 'admin')
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.key < b.key ? -1 : 1));

  const members = options.filter((option) => option.source === 'member');
  // Plain Map/Set：纯函数局部的组树结构，不是响应式状态。
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const nodes = new Map<string, MemberWorkdirNode>();
  for (const option of members) nodes.set(option.key, { option, children: [] });
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const parentOf = new Map(members.map((option) => [option.key, option.parentKey ?? null]));
  /** 沿 parentKey 上溯：parent 链路回到 childKey 即成环。 */
  const createsCycle = (childKey: string, parentKey: string): boolean => {
    let current: string | null = parentKey;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const walked = new Set<string>();
    while (current !== null && !walked.has(current)) {
      if (current === childKey) return true;
      walked.add(current);
      current = parentOf.get(current) ?? null;
    }
    return false;
  };
  const roots: MemberWorkdirNode[] = [];
  for (const option of members) {
    const node = nodes.get(option.key)!;
    const parentKey = option.parentKey ?? null;
    const parent = parentKey !== null ? nodes.get(parentKey) : undefined;
    if (parentKey !== null && parent !== undefined && !createsCycle(option.key, parentKey)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const byName = (a: MemberWorkdirNode, b: MemberWorkdirNode): number =>
    a.option.name < b.option.name ? -1 : a.option.name > b.option.name ? 1 : 0;
  const sortTree = (list: MemberWorkdirNode[]): MemberWorkdirNode[] => {
    const sorted = [...list].sort(byName);
    for (const node of sorted) node.children = sortTree(node.children);
    return sorted;
  };
  return { admin, member: sortTree(roots) };
}

/**
 * mkdir 的 parent 合法性（客户端预检，服务端仍是边界）：parentKey 未给 = 子树根
 * `member:`；否则必须出现在本人子树选项里（预置根 admin: 下不可建）。旧服务端
 *（无 parentKey 字段）缺省挂顶层。
 */
export function mkdirAllowedUnder(
  groups: WorkdirGroups,
  parentKey: string | undefined,
): boolean {
  if (parentKey === undefined) return true;
  const flat: string[] = [];
  const collect = (list: MemberWorkdirNode[]): void => {
    for (const node of list) {
      flat.push(node.option.key);
      collect(node.children);
    }
  };
  collect(groups.member);
  return flat.includes(parentKey);
}

/** 目录名预检（与服务端同口径：非空、无分隔符 / 控制字符、非 `.` / `..`）。 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export function validMkdirName(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return false;
  if (trimmed.includes('/') || trimmed.includes('\\')) return false;
  if (CONTROL_CHARS.test(trimmed)) return false;
  const base = trimmed.split('/').pop() ?? trimmed;
  return base !== '.' && base !== '..';
}

export class TeamWorkdirPickerState {
  options = $state<TeamWorkdirOption[]>([]);
  loaded = $state(false);
  loading = $state(false);
  /** options 拉取失败的服务端错误码。 */
  loadError = $state<string | null>(null);
  /** mkdir 失败的服务端错误码（WORKDIR_NOT_ALLOWED / INVALID_INPUT）。 */
  mkdirError = $state<string | null>(null);
  creating = $state(false);
  /** public Bot 只能落在预置根（B-10）：为 true 时我的目录分组不展示。 */
  adminOnly = $state(false);

  source: SourceId;

  constructor(source: SourceId, options: { adminOnly?: boolean } = {}) {
    this.source = source;
    this.adminOnly = options.adminOnly === true;
  }

  /** 组件 $effect 里同步 props（闭包内引用 props 避免仅捕获初值）。 */
  sync(source: SourceId, adminOnly: boolean): void {
    this.adminOnly = adminOnly;
    if (this.source === source) return;
    this.source = source;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading = true;
    try {
      const result = await teamBots.workdirOptions(this.source);
      this.options = result;
      this.loaded = true;
      this.loadError = null;
    } catch (error) {
      this.loadError = errorCodeOf(error);
    } finally {
      this.loading = false;
    }
  }

  get groups(): WorkdirGroups {
    const groups = groupWorkdirOptions(this.options);
    return this.adminOnly ? { admin: groups.admin, member: [] } : groups;
  }

  /**
   * 在 `parentKey`（缺省 = 本人子树根）下新建子目录；成功后重拉选项并返回新目录
   * 的选项（调用方据此选中）。失败置 mkdirError、返回 null。
   */
  async mkdir(name: string, parentKey?: string): Promise<TeamWorkdirOption | null> {
    if (!validMkdirName(name)) {
      this.mkdirError = 'INVALID_INPUT';
      return null;
    }
    if (!mkdirAllowedUnder(this.groups, parentKey)) {
      this.mkdirError = 'WORKDIR_NOT_ALLOWED';
      return null;
    }
    this.creating = true;
    this.mkdirError = null;
    try {
      const option = await teamBots.workdirMkdir(this.source, name.trim(), parentKey);
      await this.refresh();
      return option;
    } catch (error) {
      this.mkdirError = errorCodeOf(error);
      return null;
    } finally {
      this.creating = false;
    }
  }
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: string } | undefined)?.code;
  return typeof code === 'string' ? code : 'INTERNAL';
}
