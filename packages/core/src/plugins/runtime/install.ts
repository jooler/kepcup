import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  PLUGIN_RUNTIME_HOST_API_VERSION,
  PLUGIN_RUNTIME_STORAGE_QUOTA_BYTES,
  AppError,
  type PluginManifest,
  type PluginRuntimeDisclosure,
  type PluginTier,
} from '@kepcup/shared';
import { MEDIA_ENGINES } from '../../media/engines.js';
import { isHostApiRangeValid, satisfiesHostApiRange } from './version.js';

/**
 * 执行型插件的安装管线校验（D125 P2，61 §2 / §7；任务书步骤 4）——插在清单校验之
 * 后、任何持久化写入之前：
 *
 * - 层级：`runtime` 仅 builtin / verified / developer（community v1 拒绝，Q4 未决）；
 * - `runtime.entry` 必须在包目录内且是文件（路径逃逸 / 缺失拒绝；schema 层已挡
 *   `..` / 绝对路径，这里做文件系统复核）；
 * - 包内扫描：`.node` / `.wasm` 与带可执行位的文件一律拒绝（单文件 ESM 约定）；
 * - `runtime.hostApi` 必须能解析，且宿主当前 Host API 版本满足该范围——不匹配复用
 *   `PLUGIN_UPGRADE_REQUIRED`（提示升级，不静默降级）；
 * - `runtime` ⇒ 至少一条执行型可消费的条目（不填 `engine`；否则插件没有可执行体）。
 *
 * 同一份判定产出同意卡的能力披露数据（数据先行，UI 在 P3/P4 渲染）。
 */

const RUNTIME_TIERS: ReadonlySet<PluginTier> = new Set(['builtin', 'verified', 'developer']);

export interface RuntimeInstallCheck {
  /** 已暂存（或已安装）的插件目录（绝对路径）。 */
  dir: string;
  tier: PluginTier;
}

export interface RuntimeDisclosure {
  /** 非执行型插件 = null。 */
  runtime: PluginRuntimeDisclosure | null;
  /** 阻断安装的原因（空 = 可安装）。 */
  blockers: string[];
}

/** 包内扫描：native / wasm / 可执行位文件（61 §2「包防护」）。 */
async function scanPackage(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const absolute = relative === '' ? dir : path.join(dir, ...relative.split('/'));
    const info = await lstat(absolute);
    // 包防护（61 §2）：符号链接一律拒绝——即使指向包内也不允许（避免入口 / 扫描
    // 与运行时解析看到不同文件）。packager 已挡一层，这里对 builtin / 直调复核。
    if (info.isSymbolicLink()) {
      found.push(`${relative === '' ? '.' : relative}（符号链接）`);
      return;
    }
    if (info.isDirectory()) {
      for (const child of await readdir(absolute)) {
        await walk(relative === '' ? child : `${relative}/${child}`);
      }
      return;
    }
    if (!info.isFile()) return;
    const lower = relative.toLowerCase();
    if (lower.endsWith('.node') || lower.endsWith('.wasm')) {
      found.push(relative);
      return;
    }
    // Windows 没有可执行位语义；POSIX 上 0o111 任一位置位即视为可执行文件。
    if (process.platform !== 'win32' && (info.mode & 0o111) !== 0) found.push(relative);
  };
  await walk('');
  return found;
}

/** 单条校验 → 错误码 + 人话（安装抛 / 检视进 blockers 共用）。 */
function runtimeIssues(
  manifest: PluginManifest,
  tier: PluginTier,
): Array<{
  code: 'PLUGIN_INCOMPATIBLE' | 'PLUGIN_UPGRADE_REQUIRED' | 'PLUGIN_INVALID';
  message: string;
}> {
  const runtime = manifest.runtime;
  if (runtime === undefined) return [];
  const issues: Array<{
    code: 'PLUGIN_INCOMPATIBLE' | 'PLUGIN_UPGRADE_REQUIRED' | 'PLUGIN_INVALID';
    message: string;
  }> = [];
  if (!RUNTIME_TIERS.has(tier)) {
    issues.push({
      code: 'PLUGIN_INCOMPATIBLE',
      message:
        '社区层级插件不支持执行型（runtime 段）；请从市场安装 verified / builtin 版本或使用本地开发目录',
    });
  }
  if (!isHostApiRangeValid(runtime.hostApi)) {
    issues.push({
      code: 'PLUGIN_INVALID',
      message: `runtime.hostApi 无法解析：${runtime.hostApi}`,
    });
  } else if (!satisfiesHostApiRange(runtime.hostApi, PLUGIN_RUNTIME_HOST_API_VERSION)) {
    issues.push({
      code: 'PLUGIN_UPGRADE_REQUIRED',
      message: `插件要求 Host API ${runtime.hostApi}，当前应用为 ${PLUGIN_RUNTIME_HOST_API_VERSION}；请升级 KepCup 或安装兼容版本`,
    });
  }
  const entries = manifest.contributions.capabilityModels ?? [];
  // 「执行型可消费」= media 契约 v1 方法面可承接的能力；embedding / rerank 不开放
  // （60 §10 Q4），只声明它们的 runtime 插件没有可执行的条目。
  if (
    !entries.some(
      (entry) =>
        entry.engine === undefined &&
        entry.capability !== 'embedding' &&
        entry.capability !== 'rerank',
    )
  ) {
    issues.push({
      code: 'PLUGIN_INVALID',
      message: '执行型插件至少需要声明一条执行型能力条目（不填 engine，且不是 embedding / rerank）',
    });
  }
  return issues;
}

/** `runtime.entry` 存在性 + 包内路径复核。 */
async function entryIssue(manifest: PluginManifest, dir: string): Promise<string | null> {
  const entry = manifest.runtime?.entry;
  if (entry === undefined) return null;
  const root = path.resolve(dir);
  const target = path.resolve(root, ...entry.split('/'));
  if (!target.startsWith(root + path.sep)) {
    return `runtime.entry 越出插件目录：${entry}`;
  }
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) return `runtime.entry 不能是符号链接：${entry}`;
    if (!info.isFile()) return `runtime.entry 不是文件：${entry}`;
  } catch {
    return `runtime.entry 指向的文件不存在：${entry}`;
  }
  return null;
}

/**
 * 安装 / 更新前的完整校验（抛第一个问题）。调用方保证 `dir` 是本次暂存的私有副本
 * （包已通过 zip / 目录防护）。
 */
export async function assertRuntimeInstallable(
  manifest: PluginManifest,
  check: RuntimeInstallCheck,
): Promise<void> {
  if (manifest.runtime === undefined) return;
  const issues = runtimeIssues(manifest, check.tier);
  const entry = await entryIssue(manifest, check.dir);
  if (entry !== null) issues.push({ code: 'PLUGIN_INVALID', message: entry });
  const offending = await scanPackage(check.dir);
  if (offending.length > 0) {
    issues.push({
      code: 'PLUGIN_INVALID',
      message: `执行型插件包内不允许 native / 可执行文件：${offending.slice(0, 3).join('、')}`,
    });
  }
  const first = issues[0];
  if (first !== undefined) throw new AppError(first.code, first.message);
}

/**
 * 同意卡的能力披露 + 阻断列表（`plugins.inspect` 用）。校验成本与安装一致（目录扫描），
 * 但这里只收集不抛出——检视面板要一次列全部问题。
 */
export async function runtimeDisclosureOf(
  manifest: PluginManifest,
  check: RuntimeInstallCheck,
): Promise<RuntimeDisclosure> {
  const runtime = manifest.runtime;
  if (runtime === undefined) return { runtime: null, blockers: [] };
  const blockers = runtimeIssues(manifest, check.tier).map((issue) => issue.message);
  const entry = await entryIssue(manifest, check.dir);
  if (entry !== null) blockers.push(entry);
  const offending = await scanPackage(check.dir);
  if (offending.length > 0) {
    blockers.push(`执行型插件包内不允许 native / 可执行文件：${offending.slice(0, 3).join('、')}`);
  }
  // 凭据字段名披露：v1 执行型插件没有实例字段声明面（runtime 段无 fields），数据型
  // 条目（有 engine）的凭据字段照引擎声明列出——混合插件因此也能披露。
  const credentialFields: string[] = [];
  for (const entryDefinition of manifest.contributions.capabilityModels ?? []) {
    if (entryDefinition.engine === undefined) continue;
    for (const field of MEDIA_ENGINES[entryDefinition.engine]?.credentialFields ?? []) {
      if (!credentialFields.includes(field.key)) credentialFields.push(field.key);
    }
  }
  return {
    runtime: {
      hostApi: runtime.hostApi,
      networkDomains: [...(runtime.network?.allow ?? [])],
      credentialFields,
      storageQuotaBytes: PLUGIN_RUNTIME_STORAGE_QUOTA_BYTES,
    },
    blockers,
  };
}
