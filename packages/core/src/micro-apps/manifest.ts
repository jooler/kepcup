import { createHash } from 'node:crypto';
import {
  AppError,
  buildWidgetRuntimeCspHeader,
  MICRO_APP_IMPLEMENTED_CAPABILITIES,
  MICRO_APP_SPEC_VERSION,
  microAppCapabilityOf,
  microAppErrorHintOf,
  microAppFingerprintOfManifest,
  type MicroAppManifest,
} from '@kepcup/shared';
import { microAppManifestSchema } from '@kepcup/shared';

/**
 * 微应用清单的宿主侧校验与包摘要（D112，设计 55 §4.2 / §4.3）。
 *
 * 校验分层：zod（形状 / 闭合枚举 / strict）在这里之前的 shared 层；**宿主独占**的
 * 裁决在这里——`spec` 版本、声明的能力当前运行时是否已实现、net.allowlist 域名形状、
 * entry 是否指向入口 HTML。清单是「宿主独占校验」的唯一入口：渲染端与制作 loop
 * 拿到的都是已通过这里的结果，不各自再判一遍（防两套口径）。
 *
 * `bundle_sha256` = 清单 canonical JSON + 入口 HTML（P2 起再加全部文件按路径排序）的
 * sha256——它进确认记录与卡片描述符，是「代码已更新」标注的依据。能力面指纹
 * （确认粒度）不含代码内容，见 `microAppCapabilityFingerprint`（shared）。
 */

/** 清单 JSON 文本的体积上限（字节）。 */
const MANIFEST_RAW_MAX_BYTES = 64 * 1024;

export interface ValidatedMicroApp {
  manifest: MicroAppManifest;
  /** 能力面指纹（permissions + net；确认记忆的键）。 */
  fingerprint: string;
  /** bundle 规范化摘要（清单 + 全部内容；「代码已更新」标注的依据）。 */
  bundleSha256: string;
}

/**
 * 解析并裁决清单。输入是交付方（制作 loop 交付步骤 / 测试装配）给的原始 JSON；
 * 任何不合格都抛 `MICRO_APP_MANIFEST_INVALID`（spec 版本不认识抛
 * `MICRO_APP_UNSUPPORTED_SPEC`），message 面向用户，`details.hint` 面向作者（同源于
 * spec 的错误契约）。
 */
export function validateMicroAppManifest(raw: unknown, html: string): ValidatedMicroApp {
  const hint = microAppErrorHintOf('MICRO_APP_MANIFEST_INVALID');
  const fail = (message: string): AppError =>
    new AppError('MICRO_APP_MANIFEST_INVALID', message, { hint });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('micro-app.json 必须是一个 JSON 对象');
  }
  if (Buffer.byteLength(JSON.stringify(raw)) > MANIFEST_RAW_MAX_BYTES) {
    throw fail(`micro-app.json 过大（上限 ${MANIFEST_RAW_MAX_BYTES} 字节）`);
  }
  const spec = (raw as Record<string, unknown>)['spec'];
  if (spec !== undefined && spec !== MICRO_APP_SPEC_VERSION) {
    throw new AppError(
      'MICRO_APP_UNSUPPORTED_SPEC',
      `清单 spec 版本「${String(spec)}」当前 KepCup 不认识（支持：${MICRO_APP_SPEC_VERSION}）`,
      { hint: microAppErrorHintOf('MICRO_APP_UNSUPPORTED_SPEC') },
    );
  }
  const parsed = microAppManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = (issue?.path.length ?? 0) > 0 ? `（字段 ${issue?.path.join('.')}）` : '';
    throw fail(`micro-app.json 不合法${where}：${issue?.message ?? '未知错误'}`);
  }
  const manifest = parsed.data;
  // 闭合枚举之外的能力已被 zod 拒绝；这里裁决「当前运行时已实现」——声明未实现的
  // 能力 = 发一张永远打不开的卡，交付时如实拒绝（55 §5.2）。
  const unimplemented = manifest.permissions.filter((id) => !MICRO_APP_IMPLEMENTED_CAPABILITIES.includes(id));
  if (unimplemented.length > 0) {
    const upcoming = unimplemented
      .map((id) => `${id}（${microAppCapabilityOf(id)?.phase ?? '?'} 起支持）`)
      .join('、');
    throw fail(`清单声明了当前版本还不支持的能力：${upcoming}`);
  }
  if (manifest.net.mode === 'allowlist' && manifest.net.allowlist.length === 0) {
    throw fail('net.mode=allowlist 必须给出域名数组（net.allowlist）');
  }
  for (const domain of manifest.net.allowlist) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) || domain.includes('..') || domain.includes('/')) {
      throw fail(`net.allowlist 里的域名不合法：${domain}（要求形如 api.example.com 的主机名）`);
    }
  }
  // P0：entry 必须是入口 HTML 的相对名（多文件路径校验在 P2 随 micro_app_files 落地）。
  if (manifest.entry !== 'index.html') {
    throw fail('entry 目前必须是 index.html（多文件包在后续版本提供）');
  }
  if (html.trim() === '') {
    throw fail('入口 HTML 不能为空');
  }
  return {
    manifest,
    fingerprint: microAppFingerprintOfManifest(manifest),
    bundleSha256: microAppBundleSha256(manifest, html),
  };
}

/** 从版本行读回清单（存储面 → 契约）；行损坏按不存在处理（返回 null，不抛）。 */
export function manifestOfRow(manifestJson: string): ValidatedMicroApp | null {
  if (manifestJson === '') return null;
  try {
    const raw = JSON.parse(manifestJson) as unknown;
    const parsed = microAppManifestSchema.safeParse(raw);
    if (!parsed.success) return null;
    // 行内清单已过交付校验；这里只需恢复指纹。html 不参与指纹（bundle 摘要单列）。
    return {
      manifest: parsed.data,
      fingerprint: microAppFingerprintOfManifest(parsed.data),
      bundleSha256: '',
    };
  } catch {
    return null;
  }
}

/**
 * bundle 规范化摘要：清单 canonical JSON + 入口 HTML，P2 起加全部包内文件（路径排序）。
 * canonical JSON = 顶层键按字典序、无空白——同一份清单的序列化漂移不产生新摘要。
 */
export function microAppBundleSha256(manifest: MicroAppManifest, html: string): string {
  const canonical = JSON.stringify(canonicalize(manifest));
  return createHash('sha256').update(`${canonical}\n---kepcup-micro-app-bundle-v1---\n${html}`).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

/**
 * 微应用的响应头 CSP（55 §3.3）：完整 WebApp 档为基座，按清单 net 档位收紧
 * `connect-src`——`open` 不加指令（不限制，与存量组件一致）；`allowlist` 只放行
 * 声明域；`none` 全禁。资源域不随 net 收紧（外链 <img> 等由档位语义外的事项按
 * 存量行为），只管 connect。
 */
export function microAppCspFor(net: { mode: 'open' | 'allowlist' | 'none'; allowlist: readonly string[] }): string {
  if (net.mode === 'open') return buildWidgetRuntimeCspHeader();
  if (net.mode === 'none') return buildWidgetRuntimeCspHeader({ connectDomains: 'none' });
  return buildWidgetRuntimeCspHeader({
    connectDomains: net.allowlist.map((domain) => `https://${domain}`),
  });
}
