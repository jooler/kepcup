import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  isSafeMicroAppPath,
  MICRO_APP_BUNDLE_FILES_MAX,
  MICRO_APP_BUNDLE_MAX_BYTES,
  MICRO_APP_FILE_MAX_BYTES,
  MICRO_APP_IMPLEMENTED_CAPABILITIES,
  MICRO_APP_SDK_MARKER,
  type WidgetCheckIssue,
} from '@kepcup/shared';
import { validateMicroAppManifest, type ValidatedMicroApp } from '../../micro-apps/manifest.js';
import { ruleIssue } from './rules.js';

/**
 * 微应用草稿的清单 / 包 / 能力面扫描（D112 P3，设计 55 §11）：草稿带 `micro-app.json` 时
 * 由 `runWidgetCheck` 触发——清单校验、包内路径与体积、代码与声明能力的一致性
 * （只调声明过的）、权限最小性、回退路径、联网用途与成本估算、宿主可用性。
 * 每条都给可执行的下一步（改哪个文件、补哪个字段）。
 *
 * 存量组件（没有清单）整个扫描跳过——行为零变化。
 */

/** 宿主 / 阶段约定文件，不属于交付包。 */
const NON_BUNDLE = new Set([
  'index.html',
  'manifest.json',
  'micro-app.json',
  'spec.md',
  'acceptance.json',
  'queries.json',
  'fixtures.json',
]);
const NON_BUNDLE_DIRS = new Set(['reports', 'snapshots', 'references']);

/** 草稿里的微应用包（清单 + 全部交付文件）。 */
export interface MicroAppDraftBundle {
  manifestJson: string;
  files: Array<{ path: string; bytes: number; contentBase64: string }>;
}

/** 枚举草稿目录里的交付文件（约定 / 宿主文件除外）。 */
export function readMicroAppDraftBundle(draftDir: string): MicroAppDraftBundle | null {
  const manifestPath = path.join(draftDir, 'micro-app.json');
  if (!existsSync(manifestPath)) return null;
  const manifestJson = readFileSync(manifestPath, 'utf8');
  const files: Array<{ path: string; bytes: number; contentBase64: string }> = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (NON_BUNDLE_DIRS.has(entry.name) && prefix === '') continue;
        walk(path.join(dir, entry.name), rel);
        continue;
      }
      if (prefix === '' && NON_BUNDLE.has(entry.name)) continue;
      const bytes = statSync(path.join(dir, entry.name)).size;
      files.push({
        path: rel,
        bytes,
        contentBase64: readFileSync(path.join(dir, entry.name)).toString('base64'),
      });
    }
  };
  walk(draftDir, '');
  return { manifestJson, files };
}

/**
 * JS 表面 → 能力（能力一致性的判定字典）：按垫片暴露的 JS 调用形态匹配，与 spec 的桥
 * 方法名是两套命名（JS 面是产品 API，桥面是协议）——这里只认 JS 面，检查器引用的方法名
 * 与 sdk.md 一致。files.pick / notify / net.fetch 尚未实现（P3+），不进字典。
 */
const JS_CAPABILITY_PATTERNS: ReadonlyArray<{ capability: string; re: RegExp; usage: string }> = [
  { capability: 'storage.kv', re: /kepcup\.storage\./, usage: 'kepcup.storage.get/set/delete/list' },
  { capability: 'storage.collection', re: /kepcup\.collections\./, usage: 'kepcup.collections.put/get/list/delete/query' },
  { capability: 'host.reply', re: /kepcup\.reply\s*\(/, usage: 'kepcup.reply(text)' },
  { capability: 'host.openLink', re: /kepcup\.openLink\s*\(/, usage: 'kepcup.openLink(url)' },
  { capability: 'ai.chat', re: /kepcup\.ai\./, usage: 'kepcup.ai.chat(...) / kepcup.ai.session(...)' },
  { capability: 'media.listen', re: /kepcup\.media\.listen\s*\(/, usage: 'kepcup.media.listen(...)' },
  { capability: 'media.speak', re: /kepcup\.media\.(speak|stopSpeaking)\s*\(/, usage: 'kepcup.media.speak(...) / kepcup.media.stopSpeaking()' },
  { capability: 'context.update', re: /kepcup\.context\./, usage: 'kepcup.context.update(...) / kepcup.context.clear()' },
];

export interface MicroAppDraftScanInput {
  bundle: MicroAppDraftBundle;
  /** 入口 HTML（垫片注入前的原文——注入是 open 时的事，检查看作者写了什么）。 */
  html: string;
  spec: string | null;
  /** 宿主能力可用性探针（缺配置 → warning + 设置深链；55 §11）。 */
  capabilityAvailability?: (capability: string) => { available: boolean; reason?: string } | undefined;
}

export function microAppDraftIssues(input: MicroAppDraftScanInput): WidgetCheckIssue[] {
  const issues: WidgetCheckIssue[] = [];
  let manifest: ValidatedMicroApp;
  try {
    manifest = validateMicroAppManifest(JSON.parse(input.bundle.manifestJson) as unknown, input.html);
  } catch (error) {
    issues.push(
      ruleIssue('app.manifest-invalid', {
        file: 'micro-app.json',
        message: `清单不合法：${error instanceof Error ? error.message : String(error)}`,
      }),
    );
    // 清单都不合法时能力面无从谈起：后面的规则需要清单成立。
    return issues;
  }
  const permissions = manifest.manifest.permissions;

  // 包内文件：路径安全 / 单文件与包总量 / 数量（与交付侧 #cleanFiles 同一判定，提前到 GATE）。
  if (input.bundle.files.length > MICRO_APP_BUNDLE_FILES_MAX) {
    issues.push(
      ruleIssue('app.bundle-invalid', {
        file: 'micro-app.json',
        message: `包内文件数超上限（${MICRO_APP_BUNDLE_FILES_MAX}，当前 ${input.bundle.files.length}）：把不需要的资产删掉`,
      }),
    );
  }
  let totalBytes = 0;
  for (const file of input.bundle.files) {
    if (!isSafeMicroAppPath(file.path)) {
      issues.push(
        ruleIssue('app.bundle-invalid', {
          file: 'micro-app.json',
          message: `包内路径不合法：${file.path}（相对路径、不以 / 或 .. 开头、不含反斜杠与空段）`,
        }),
      );
    }
    if (file.path === 'index.html') {
      issues.push(
        ruleIssue('app.bundle-invalid', {
          file: 'micro-app.json',
          message: 'index.html 是入口 HTML，写在草稿根目录的 index.html（不要放进 micro-app.json 的 files）',
        }),
      );
    }
    if (file.bytes > MICRO_APP_FILE_MAX_BYTES) {
      issues.push(
        ruleIssue('app.bundle-invalid', {
          file: 'micro-app.json',
          message: `包内文件超上限（${file.path}，≤1MB）：压缩或拆分资产`,
        }),
      );
    }
    totalBytes += file.bytes;
  }
  if (totalBytes > MICRO_APP_BUNDLE_MAX_BYTES) {
    issues.push(
      ruleIssue('app.bundle-invalid', {
        file: 'micro-app.json',
        message: `包总量超上限（8MB，含入口 HTML）：压缩图片 / 删掉未引用的资产`,
      }),
    );
  }

  // 能力一致性：只调声明过的（app.permission-undeclared / app.sdk-deprecated）。
  const usedCapabilities = new Set<string>();
  for (const pattern of JS_CAPABILITY_PATTERNS) {
    if (!pattern.re.test(input.html)) continue;
    usedCapabilities.add(pattern.capability);
    if (!permissions.includes(pattern.capability)) {
      issues.push(
        ruleIssue('app.permission-undeclared', {
          message: `代码调用了 ${pattern.usage}，但清单 permissions 没有声明能力 ${pattern.capability}：补进 micro-app.json（能力扩大会触发用户重新确认），或删掉这段调用`,
        }),
      );
    }
  }

  // 权限最小性：声明了但代码从未调用（storage.kv 例外——预置数据 / 后台同步也算合理声明）。
  for (const capability of permissions) {
    if (capability === 'storage.kv') continue;
    if (usedCapabilities.has(capability)) continue;
    issues.push(
      ruleIssue('app.permission-overbroad', {
        file: 'micro-app.json',
        message: `声明了能力 ${capability} 但代码从未调用：从 permissions 删掉它（能力面越小，用户确认越快），或补上调用`,
      }),
    );
  }

  // 回退路径：声明了任何「环境可能没有」的能力，就必须有键盘降级（55 §11 通用化）。
  const environmentCaps = permissions.filter((capability) =>
    ['ai.chat', 'media.listen', 'media.speak', 'files.pick', 'notify'].includes(capability),
  );
  if (environmentCaps.length > 0 && !/<input[\s>]|<textarea[\s>]/i.test(input.html)) {
    issues.push(
      ruleIssue('app.fallback-missing', {
        message:
          `声明了 ${environmentCaps.join(' / ')}，但页面上没有任何文本输入（<input> / <textarea>）：` +
          '能力不可用（麦克风被拒 / 缺模型配置）时用户没有第二条路——补一个键盘输入区并在错误处理里切过去',
      }),
    );
  }

  // 成本估算：用了宿主模型就要在 spec.md 里写每轮对话的成本量级（55 §11 SPEC 必答）。
  if (permissions.includes('ai.chat') && input.spec !== null) {
    if (!/成本|token|预算/.test(input.spec)) {
      issues.push(
        ruleIssue('app.cost-estimate-missing', {
          file: 'spec.md',
          message: 'spec.md 没有写每轮对话的成本估算：加一行「每轮约 N token（模型回复长度 × 轮数）」——用量计入编写本微应用的 Bot，用户在确认卡与管理页看得到',
        }),
      );
    }
  }

  // 联网用途：保留默认 open 就要在 spec.md 写用途与失败降级（55 §3.3，P0 注册的规则）。
  if (manifest.manifest.net.mode === 'open' && input.spec !== null) {
    if (!/联网|网络|net\.fetch|https?/.test(input.spec)) {
      issues.push(
        ruleIssue('app.net-open-default', {
          file: 'spec.md',
          message:
            '保留默认联网（net.mode=open）但 spec.md 没写联网用途：补一行「用网络做什么 + 断网时怎么降级」；不需要联网就在清单里收紧为 none 或 allowlist',
        }),
      );
    }
  }

  // 宿主可用性：缺配置的能力提前标出（55 §11：GATE 就告诉模型，别等用户打开才失败）。
  if (input.capabilityAvailability !== undefined) {
    for (const capability of permissions) {
      if (!MICRO_APP_IMPLEMENTED_CAPABILITIES.includes(capability)) continue;
      const probe = input.capabilityAvailability(capability);
      if (probe === undefined || probe.available) continue;
      issues.push(
        ruleIssue('app.capability-unavailable', {
          file: 'micro-app.json',
          message: `能力 ${capability} 当前宿主不可用${probe.reason !== undefined ? `：${probe.reason}` : ''}——发布前引导用户去设置页配置；代码要按 app.ready() 的返回值降级（这条不阻断交付，但用户打开就会遇到）`,
        }),
      );
    }
  }

  return issues;
}

/** 检查器引用的垫片标记（守卫测试确认注入物与扫描的假设一致）。 */
export const MICRO_APP_CHECK_SDK_MARKER = MICRO_APP_SDK_MARKER;
