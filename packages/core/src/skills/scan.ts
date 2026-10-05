import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  SKILL_SCAN_FILES_MAX,
  type SkillCompatibility,
  type SkillDeclaredPermissions,
  type SkillFile,
  type SkillScan,
} from '@kepcup/shared';

import type { parseSkillDir } from './parse.js';
import { splitFrontmatter, readSkillMarkdown } from './parse.js';

/**
 * Static scan of one skill directory (docs/dev/phases/P08-skills.md 任务 2):
 * file inventory, declared permissions, runtime-dependency inference,
 * compatibility verdict and risk hints. Pure file reading — nothing is
 * executed (docs 注意事项: 导入绝不执行仓库代码).
 */

const SCRIPT_EXTENSIONS: Record<string, SkillFile['kind']> = {
  '.py': 'script-python',
  '.pyw': 'script-python',
  '.mjs': 'script-node',
  '.cjs': 'script-node',
  '.js': 'script-node',
  '.ts': 'script-node',
  '.sh': 'script-shell',
  '.bash': 'script-shell',
};

const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.rst']);
const DATA_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml', '.csv']);

/** Text extensions we inspect for risk keywords; everything else may be binary. */
const INSPECTABLE = new Set<string>([
  ...Object.keys(SCRIPT_EXTENSIONS),
  ...DOC_EXTENSIONS,
  ...DATA_EXTENSIONS,
]);

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.tar',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.wasm',
]);

const NETWORK_PATTERNS: Array<[RegExp, string]> = [
  [/\bcurl\b/, '脚本包含 curl 网络请求'],
  [/\bwget\b/, '脚本包含 wget 网络下载'],
  [/https?:\/\//, '脚本包含网络地址'],
  [/\bfetch\s*\(/, '脚本包含 fetch 网络请求'],
  [/\brequests\.(get|post|put|delete)/, '脚本包含 Python requests 网络请求'],
  [/\burllib\b/, '脚本包含 urllib 网络请求'],
  [/\bsocket\b/, '脚本包含直接 socket 访问'],
];

const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
  [/\b(api[_-]?key|access[_-]?token|secret)\b/i, '脚本引用密钥或令牌（凭据读取风险）'],
  [/\.ssh|id_rsa|\.aws\/credentials|\.netrc/, '脚本引用 SSH/AWS 凭据位置'],
  [/\bkeychain\b|\bcredential[-_ ]?manager\b/i, '脚本引用系统凭据存储'],
];

/** Host-only capabilities that imported skills cannot rely on here (design 05 兼容性). */
const HOST_CAPABILITY_PATTERNS: Array<[RegExp, string]> = [
  [/\bmcp__/, '引用 MCP 专有工具（mcp__ 前缀），本宿主不提供'],
  [/\bTask\s*(工具|tool|subagent|子代理)/i, '引用 Task 子代理工具，本宿主不提供'],
  [/\bTaskTool\b/, '引用 TaskTool 子代理工具，本宿主不提供'],
  [/\bSlashCommand\b/, '引用 SlashCommand 宿主命令，本宿主不提供'],
  [/\bBashOutput\b|\bKillShell\b/, '引用后台 shell 宿主工具，本宿主不提供'],
  // WebSearch/WebFetch 自 P18 起由宿主内置（web_search/web_fetch 工具，
  // docs/design/21-web-search.md）——不再列为不兼容能力。
  [/\bVSCode\b|\bJetBrains\b/, '引用特定 IDE 集成，本宿主不提供'],
];

interface ShebangRuntime {
  runtime: string;
  args: string[];
}

function detectShebang(firstLine: string): ShebangRuntime | null {
  if (!firstLine.startsWith('#!')) return null;
  const parts = firstLine.slice(2).trim().split(/\s+/);
  let program = parts[0]?.split('/').pop() ?? '';
  let args = parts.slice(1);
  if (program === 'env' && args.length > 0) {
    // `#!/usr/bin/env bash` — the runtime is env's first argument.
    program = args[0]!.split('/').pop() ?? '';
    args = args.slice(1);
  }
  switch (program) {
    case 'python':
    case 'python3':
    case 'uv':
      return { runtime: program === 'uv' ? 'uv' : 'python', args };
    case 'node':
    case 'deno':
    case 'bun':
      return { runtime: 'node', args };
    case 'bash':
    case 'sh':
      return { runtime: 'bash', args };
    default:
      return { runtime: program, args };
  }
}

export function classifyFile(relativePath: string, absolutePath: string): SkillFile {
  const ext = path.extname(relativePath).toLowerCase();
  const name = path.basename(relativePath).toLowerCase();
  let executable = false;
  let firstLine = '';
  try {
    const stats = statSync(absolutePath);
    // Windows has no executable bit; an exec flag alone never classifies.
    executable = stats.mode & 0o111 ? true : false;
    if (stats.isFile() && stats.size > 0 && (INSPECTABLE.has(ext) || name === 'skill.md')) {
      firstLine = readFileSync(absolutePath, 'utf8').split('\n', 1)[0] ?? '';
    } else if (stats.isFile() && stats.size > 0 && ext.length === 0) {
      // Extension-less script with a shebang (e.g. `run`).
      const head = readFileSync(absolutePath, 'utf8').split('\n', 1)[0] ?? '';
      if (head.startsWith('#!')) firstLine = head;
    }
  } catch {
    // vanished mid-scan: classify by name only
  }
  if (name === 'skill.md') return { path: relativePath, kind: 'skill-doc', executable };
  const shebang = firstLine.startsWith('#!') ? detectShebang(firstLine) : null;
  if (shebang?.runtime === 'python')
    return { path: relativePath, kind: 'script-python', executable };
  if (shebang?.runtime === 'node') return { path: relativePath, kind: 'script-node', executable };
  if (shebang?.runtime === 'bash' || shebang?.runtime === 'sh') {
    return { path: relativePath, kind: 'script-shell', executable };
  }
  if (BINARY_EXTENSIONS.has(ext)) return { path: relativePath, kind: 'binary', executable };
  if (SCRIPT_EXTENSIONS[ext] !== undefined)
    return { path: relativePath, kind: SCRIPT_EXTENSIONS[ext]!, executable };
  if (DOC_EXTENSIONS.has(ext)) return { path: relativePath, kind: 'doc', executable };
  if (DATA_EXTENSIONS.has(ext)) return { path: relativePath, kind: 'data', executable };
  return { path: relativePath, kind: 'other', executable };
}

function walkFiles(dir: string, prefix = ''): Array<{ rel: string; abs: string }> {
  const files: Array<{ rel: string; abs: string }> = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      files.push(...walkFiles(abs, rel));
    } else if (entry.isFile()) {
      files.push({ rel, abs });
    }
  }
  return files;
}

/** Dependency inference from shebangs + requirements.txt + package.json (任务 2). */
export function inferRuntimeDeps(
  files: Array<{ rel?: string; path?: string; abs: string; kind: SkillFile['kind'] }>,
): string[] {
  const deps = new Set<string>();
  for (const file of files) {
    if (file.kind === 'script-python') deps.add('python');
    if (file.kind === 'script-node') deps.add('node');
    if (file.kind === 'script-shell') deps.add('bash');
    try {
      const firstLine = readFileSync(file.abs, 'utf8').split('\n', 1)[0] ?? '';
      const shebang = detectShebang(firstLine);
      if (shebang) {
        if (shebang.runtime === 'python' || shebang.runtime === 'uv') {
          deps.add(shebang.runtime);
        } else if (shebang.runtime === 'node') {
          deps.add('node');
        } else if (shebang.runtime === 'bash' || shebang.runtime === 'sh') {
          deps.add('bash');
        } else {
          deps.add(shebang.runtime);
        }
      }
    } catch {
      // unreadable file: the classification above still applies
    }
  }
  const names = new Set(
    files.map((file) => path.basename(file.rel ?? file.path ?? '').toLowerCase()),
  );
  if (names.has('requirements.txt') || names.has('pyproject.toml')) deps.add('python');
  if (names.has('package.json')) deps.add('node');
  return [...deps].sort();
}

/** One frontmatter value in either form (scalar or list). */
function frontmatterList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

function declaredPermissionsOf(
  frontmatter: Record<string, string | string[]>,
): SkillDeclaredPermissions {
  const values = [
    ...frontmatterList(frontmatter['permissions']),
    ...frontmatterList(frontmatter['allowed-tools']),
  ];
  const notes: string[] = [];
  let network = false;
  let credentials = false;
  for (const raw of values) {
    const entry = String(raw).trim();
    if (entry.length === 0) continue;
    const lowered = entry.toLowerCase();
    notes.push(entry);
    if (/network|net|http|web|internet/.test(lowered)) network = true;
    if (/credential|secret|key|token|password/.test(lowered)) credentials = true;
  }
  return { network, credentials, notes };
}

/**
 * Scans one skill directory. `parse` is reused when the caller already parsed
 * the directory (import flow); description truncation happens in parse.
 *
 * P12: `options.enhancedSandboxAvailable` decides the verdict for a
 * `sandbox: enhanced` frontmatter declaration — incompatible (with an
 * install hint upstream) while the enhanced backend is missing, usable once
 * it is provided. The declaration itself is always recorded on the scan
 * (shared `sandboxDeclaration`) so the registry can re-evaluate later
 * without re-reading the directory. `unsandboxed` declarations stay
 * incompatible in every case (技能脚本绝不在沙箱外执行).
 */
export function scanSkillDir(
  dir: string,
  parsed: ReturnType<typeof parseSkillDir>,
  options: { enhancedSandboxAvailable?: boolean } = {},
): SkillScan {
  const enhancedAvailable = options.enhancedSandboxAvailable ?? false;
  const allFiles = walkFiles(dir);
  const classified = allFiles.map((file) => ({
    ...classifyFile(file.rel, file.abs),
    abs: file.abs,
  }));
  const markdown = readSkillMarkdown(dir);
  const split = splitFrontmatter(markdown);
  const body = split?.body ?? markdown;
  const frontmatter = parsed?.frontmatter ?? {};

  // Compatibility (任务 2): host-only capabilities → partial; an explicit
  // enhanced-sandbox requirement depends on the enhanced backend (P12) and
  // an unsandboxed requirement is never granted.
  const compatibilityReasons: string[] = [];
  let compatibility: SkillCompatibility = 'compatible';
  const sandboxRaw =
    typeof frontmatter['sandbox'] === 'string' ? frontmatter['sandbox'].toLowerCase() : '';
  let sandboxDeclaration: 'enhanced' | 'unsandboxed' | null = null;
  if (sandboxRaw === 'enhanced' || sandboxRaw === 'elevated') {
    sandboxDeclaration = 'enhanced';
    if (!enhancedAvailable) {
      compatibility = 'incompatible';
      compatibilityReasons.push('声明需要增强沙箱（当前未安装增强沙箱，可在设置页按需安装）');
    }
  } else if (sandboxRaw === 'unsandboxed') {
    sandboxDeclaration = 'unsandboxed';
    compatibility = 'incompatible';
    compatibilityReasons.push('声明需要沙箱外执行（本宿主不会在沙箱外运行技能脚本）');
  }
  if (parsed === null) {
    compatibility = 'incompatible';
    compatibilityReasons.push('缺少可识别的 SKILL.md（name/description 不符合 Agent Skills 规范）');
  }
  const haystacks = [
    body,
    ...classified
      .filter((f) => f.kind !== 'binary')
      .map((f) => {
        try {
          return readFileSync(f.abs, 'utf8');
        } catch {
          return '';
        }
      }),
  ];
  for (const [pattern, reason] of HOST_CAPABILITY_PATTERNS) {
    if (reason.length === 0) continue;
    if (haystacks.some((text) => pattern.test(text))) {
      if (compatibility === 'compatible') compatibility = 'partial';
      if (!compatibilityReasons.includes(reason)) compatibilityReasons.push(reason);
    }
  }

  // Risks: network/credential references inside scripts + binary files.
  const risks: string[] = [];
  const scriptTexts = classified
    .filter((f) => f.kind.startsWith('script-'))
    .map((f) => {
      try {
        return readFileSync(f.abs, 'utf8');
      } catch {
        return '';
      }
    });
  const riskMentioned = (reason: string) =>
    risks.some((risk) => risk.startsWith(reason.split('（')[0]!));
  for (const [pattern, reason] of NETWORK_PATTERNS) {
    if (scriptTexts.some((text) => pattern.test(text)) && !riskMentioned(reason)) {
      risks.push(`${reason}（脚本）`);
    }
  }
  for (const [pattern, reason] of CREDENTIAL_PATTERNS) {
    if (scriptTexts.some((text) => pattern.test(text)) && !riskMentioned(reason)) {
      risks.push(reason);
    }
  }
  if (classified.some((f) => f.kind === 'binary')) {
    risks.push('包含二进制文件（无法静态审查内容）');
  }
  const declared = declaredPermissionsOf(frontmatter);
  if (declared.network && !risks.some((risk) => risk.includes('网络'))) {
    risks.push('frontmatter 声明需要网络访问');
  }
  if (
    declared.credentials &&
    !risks.some((risk) => risk.includes('凭据') || risk.includes('密钥'))
  ) {
    risks.push('frontmatter 声明需要凭据');
  }
  if (classified.some((f) => f.executable && f.kind.startsWith('script-'))) {
    risks.push('包含可执行脚本（只在沙箱中执行）');
  }

  // files (任务 2: "脚本文件列表"): scripts only, not the whole tree — the
  // list feeds the approval payload and skill_library.scan_json, so it stays
  // bounded even for hostile repositories (BR-P08-010).
  const scriptFiles = classified
    .filter((f) => f.kind.startsWith('script-'))
    .map(({ abs: _abs, ...file }) => file);
  const files = scriptFiles.slice(0, SKILL_SCAN_FILES_MAX);
  if (scriptFiles.length > files.length) {
    risks.push(`脚本清单超过 ${SKILL_SCAN_FILES_MAX} 个，仅保留前 ${SKILL_SCAN_FILES_MAX} 条`);
  }

  return {
    name: parsed?.name ?? path.basename(dir),
    description: parsed?.description ?? '',
    files,
    declaredPermissions: declared,
    runtimeDeps: inferRuntimeDeps(classified),
    compatibility,
    compatibilityReasons,
    risks,
    sandboxDeclaration,
  };
}
