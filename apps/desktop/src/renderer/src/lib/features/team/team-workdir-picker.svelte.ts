import type { TeamWorkdirOption } from '@kepcup/shared';
import type { SourceId } from '$lib/rpc/connections.svelte';
import { teamBots } from './team-bots.svelte';

/**
 * TeamWorkdirPicker 的表单逻辑（member-bots B4 子域 A）：`team.bots.workdirOptions`
 * 拉取 + 分组（admin 启用根 / 我的目录，B-10）+ `team.bots.workdirMkdir` 新建子
 * 文件夹（仅本人 workdirs 子树）。不做自由路径输入——成员永不浏览任意 FS，
 * 越界（WORKDIR_NOT_ALLOWED）与非法目录名（INVALID_INPUT）以错误码呈现。
 */

export interface WorkdirGroups {
  admin: TeamWorkdirOption[];
  member: TeamWorkdirOption[];
}

/** 纯分组（展示顺序：admin 根在前，我的目录在后，各自按 path 排序稳定）。 */
export function groupWorkdirOptions(options: readonly TeamWorkdirOption[]): WorkdirGroups {
  const admin = options.filter((option) => option.source === 'admin');
  const member = options.filter((option) => option.source === 'member');
  const byPath = (a: TeamWorkdirOption, b: TeamWorkdirOption): number =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  return { admin: [...admin].sort(byPath), member: [...member].sort(byPath) };
}

/**
 * mkdir 的 parent 合法性（客户端预检，服务端仍是边界）：admin 根下不可建；
 * member 目录与缺省（本人 workdirs 根）可建。parentPath 未给 = 子树根。
 */
export function mkdirAllowedUnder(
  groups: WorkdirGroups,
  parentPath: string | undefined,
): boolean {
  if (parentPath === undefined) return true;
  return groups.member.some((option) => option.path === parentPath);
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
  /** public Bot 只能落在管理根（B-10）：为 true 时我的目录分组不展示。 */
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
      this.options = await teamBots.workdirOptions(this.source);
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
   * 在 `parentPath`（缺省 = 本人 workdirs 根）下新建子文件夹；成功后重拉选项并
   * 返回新路径（调用方据此选中）。失败置 mkdirError、返回 null。
   */
  async mkdir(name: string, parentPath?: string): Promise<string | null> {
    if (!validMkdirName(name)) {
      this.mkdirError = 'INVALID_INPUT';
      return null;
    }
    if (!mkdirAllowedUnder(this.groups, parentPath)) {
      this.mkdirError = 'WORKDIR_NOT_ALLOWED';
      return null;
    }
    this.creating = true;
    this.mkdirError = null;
    try {
      const path = await teamBots.workdirMkdir(this.source, name.trim(), parentPath);
      await this.refresh();
      return path;
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
