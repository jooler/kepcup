import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { rmSync } from '../../infra/fs-rm.js';
import path from 'node:path';
import {
  WIDGET_CRAFT_DRAFT_TTL_DAYS,
  widgetCraftManifestSchema,
  widgetQueryDefSchema,
  type MicroAppManifest,
  type WidgetCheckReport,
  type WidgetCraftManifest,
  type WidgetQueryDef,
} from '@kepcup/shared';
import { botWidgetDraftDir, botWidgetDraftsDir, type AppPaths } from '../../infra/paths.js';
import { microAppBundleSha256 } from '../../micro-apps/manifest.js';
import { queriesSha256Of } from '../service.js';

/**
 * 制作 loop 的草稿目录（设计 32 §11.5）：`bots/{botId}/widget-drafts/{craftId}/`，应用自有。
 * 阶段之间以这里的文件为记忆——每个阶段 run 的输入由宿主从这些文件重建。
 *
 * - `manifest.json` 由宿主独占写（原子替换）；模型的文件工具对它只读（tools.ts 守卫）。
 * - `snapshots/round-{n}/` 是每次 GATE 时 `index.html` + `queries.json` 的快照（回滚到最佳快照用）。
 * - `reports/check-{n}.json` 是每次 GATE 的检查报告（只存文本，不存截图）。
 * - 交付成功即删除整个目录；未交付的保留 {@link WIDGET_CRAFT_DRAFT_TTL_DAYS} 天供续做。
 */

export const DRAFT_MANIFEST = 'manifest.json';
export const DRAFT_HTML = 'index.html';
export const DRAFT_QUERIES = 'queries.json';
export const DRAFT_SPEC = 'spec.md';
export const DRAFT_ACCEPTANCE = 'acceptance.json';
export const DRAFT_FIXTURES = 'fixtures.json';
/** 微应用清单（D112 P3）：存在即微应用草稿（多文件 + 能力面）。 */
export const DRAFT_APP_MANIFEST = 'micro-app.json';
/** 写作知识分层（55 §6.1）：宿主在草稿创建时物化，模型只读（不在可写集合）。 */
export const DRAFT_REFERENCES_DIR = 'references';

/** 宿主 / 阶段约定文件与目录：不属于交付包，快照与摘要都不碰。 */
const NON_BUNDLE_FILES = new Set([
  DRAFT_MANIFEST,
  DRAFT_HTML,
  DRAFT_SPEC,
  DRAFT_ACCEPTANCE,
  DRAFT_FIXTURES,
  DRAFT_APP_MANIFEST,
]);
const NON_BUNDLE_DIRS = new Set(['reports', 'snapshots', 'references']);

/** 交付物的摘要（回执关卡的比对对象）；微应用草稿带包摘要与文件清单摘要。 */
export interface DraftDigest {
  htmlSha256: string;
  queriesSha256: string;
  /** 微应用包摘要（manifest + 入口 HTML 的 canonical sha256；存量组件草稿为空串）。 */
  bundleSha256: string;
  /** 包文件清单摘要（排序 path:sha256；P3 审查修复——改资产不改 HTML 也要重过 GATE）。 */
  filesSha256: string;
}

export class WidgetDraft {
  readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  /** 新建一次制作的草稿目录（目录已存在则视为冲突，craftId 是随机 id 不应发生）。 */
  static create(paths: AppPaths, manifest: WidgetCraftManifest): WidgetDraft {
    const dir = botWidgetDraftDir(paths, manifest.botId, manifest.craftId);
    if (existsSync(dir)) throw new Error(`widget draft already exists: ${manifest.craftId}`);
    mkdirSync(dir, { recursive: true });
    const draft = new WidgetDraft(dir);
    draft.writeManifest(manifest);
    return draft;
  }

  /** 打开已有草稿（续做）；不存在或 manifest 损坏为 null。 */
  static open(paths: AppPaths, botId: string, craftId: string): WidgetDraft | null {
    if (!/^[A-Za-z0-9_-]+$/.test(craftId)) return null;
    const dir = botWidgetDraftDir(paths, botId, craftId);
    if (!existsSync(path.join(dir, DRAFT_MANIFEST))) return null;
    const draft = new WidgetDraft(dir);
    return draft.tryReadManifest() === null ? null : draft;
  }

  readManifest(): WidgetCraftManifest {
    const manifest = this.tryReadManifest();
    if (manifest === null) throw new Error('widget draft manifest is missing or corrupt');
    return manifest;
  }

  tryReadManifest(): WidgetCraftManifest | null {
    try {
      const raw = JSON.parse(readFileSync(path.join(this.dir, DRAFT_MANIFEST), 'utf8')) as unknown;
      const parsed = widgetCraftManifestSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** 原子写 manifest（临时文件 + rename：崩溃时不留半个文件）。 */
  writeManifest(manifest: WidgetCraftManifest): void {
    const target = path.join(this.dir, DRAFT_MANIFEST);
    const tmp = `${target}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    renameSync(tmp, target);
  }

  updateManifest(
    patch: (manifest: WidgetCraftManifest) => WidgetCraftManifest,
  ): WidgetCraftManifest {
    const next = patch(this.readManifest());
    this.writeManifest(next);
    return next;
  }

  path(name: string): string {
    return path.join(this.dir, name);
  }

  exists(name: string): boolean {
    return existsSync(this.path(name));
  }

  /** 读文本文件；不存在为 null。 */
  read(name: string): string | null {
    try {
      return readFileSync(this.path(name), 'utf8');
    } catch {
      return null;
    }
  }

  write(name: string, content: string): void {
    this.#ensureSubdir(path.dirname(this.path(name)));
    writeFileSync(this.path(name), content, 'utf8');
  }

  /** 按原字节写（微应用包文件的二进制资产——base64 往返不走 utf8 字符串）。 */
  writeBytes(name: string, content: Buffer): void {
    this.#ensureSubdir(path.dirname(this.path(name)));
    writeFileSync(this.path(name), content);
  }

  /**
   * 建草稿目录下的子目录，但不重建草稿目录本身：Bot 删除时 `bots/{id}` 整个被删，进行中的
   * 制作不能把它写回来（之后的写入直接失败，制作按出错收尾）。
   */
  #ensureSubdir(dir: string): void {
    if (!existsSync(this.dir)) throw new Error('widget draft directory is gone');
    mkdirSync(dir, { recursive: true });
  }

  remove(name: string): void {
    rmSync(this.path(name), { force: true });
  }

  /** 草稿是不是微应用（有 micro-app.json）。 */
  hasAppManifest(): boolean {
    return this.exists(DRAFT_APP_MANIFEST);
  }

  /** micro-app.json 原文（不存在为 null）。 */
  appManifestJson(): string | null {
    return this.read(DRAFT_APP_MANIFEST);
  }

  /**
   * 当前交付物的摘要：HTML 是原文的 sha256（与 WidgetService 落库同口径），查询是
   * `queries.json` 里合法条目的规范摘要（缺省 / 无法解析 = 按无查询计；这种草稿的 GATE
   * 会因 `query.invalid` 判定阻断，不会留下可交付的回执）。微应用草稿另带包摘要
   * （清单 + 入口 HTML 的 canonical sha256，P2 落库同算法）。
   */
  digest(): DraftDigest {
    const html = this.read(DRAFT_HTML) ?? '';
    return {
      htmlSha256: createHash('sha256').update(html).digest('hex'),
      queriesSha256: queriesSha256Of(this.queries() ?? []),
      bundleSha256: this.#bundleSha256(html),
      filesSha256: this.#filesSha256(),
    };
  }

  #bundleSha256(html: string): string {
    const raw = this.appManifestJson();
    if (raw === null) return '';
    try {
      return microAppBundleSha256(JSON.parse(raw) as MicroAppManifest, html);
    } catch {
      return '';
    }
  }

  /** 包文件清单摘要：排序 (path:sha256(content)) 后整体 sha256（无包 = 空串）。 */
  #filesSha256(): string {
    if (!this.hasAppManifest()) return '';
    const entries = this.bundleFiles()
      .map((file) => `${file.path}:${createHash('sha256').update(Buffer.from(file.contentBase64, 'base64')).digest('hex')}`)
      .sort();
    return createHash('sha256').update(entries.join('\n')).digest('hex');
  }

  /**
   * 交付物：只读一次，摘要就按读到的这份字节算（同 {@link digest} 口径）；`queries` 为 null =
   * queries.json 不合法（这种草稿不会有可交付回执）。微应用草稿带清单原文与包文件。
   */
  deliverable(): {
    html: string;
    queries: WidgetQueryDef[] | null;
    digest: DraftDigest;
    appManifestJson: string | null;
    files: Array<{ path: string; mime: string; contentBase64: string }>;
  } {
    const html = this.read(DRAFT_HTML) ?? '';
    const queries = parseQueries(this.read(DRAFT_QUERIES));
    const appManifestJson = this.appManifestJson();
    const files = appManifestJson !== null ? this.bundleFiles() : [];
    return {
      html,
      queries,
      digest: {
        htmlSha256: createHash('sha256').update(html).digest('hex'),
        queriesSha256: queriesSha256Of(queries ?? []),
        bundleSha256: this.#bundleSha256(html),
        filesSha256: this.#filesSha256(),
      },
      appManifestJson,
      files,
    };
  }

  /** 包内文件（约定的宿主 / 阶段文件与目录除外；mime 按扩展名粗判，交付侧再校验）。 */
  bundleFiles(): Array<{ path: string; mime: string; contentBase64: string }> {
    const out: Array<{ path: string; mime: string; contentBase64: string }> = [];
    const walk = (dir: string, prefix: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          if (prefix === '' && NON_BUNDLE_DIRS.has(entry.name)) continue;
          walk(path.join(dir, entry.name), rel);
          continue;
        }
        if (prefix === '' && NON_BUNDLE_FILES.has(entry.name)) continue;
        out.push({
          path: rel,
          mime: mimeOfPath(rel),
          contentBase64: readFileSync(path.join(dir, entry.name)).toString('base64'),
        });
      }
    };
    walk(this.dir, '');
    return out;
  }

  /** 宿主物化写作知识分层（references/*.md，模型只读）。 */
  writeSdkReferences(bodies: Readonly<Record<string, string>>): void {
    for (const [file, body] of Object.entries(bodies)) {
      this.write(file, `${body}\n`);
    }
  }

  /** `queries.json` 的条目（缺省为 []；JSON / 形状不合法为 null）。 */
  queries(): WidgetQueryDef[] | null {
    return parseQueries(this.read(DRAFT_QUERIES));
  }

  /** 快照覆盖的交付物：入口 + 查询 + 微应用清单与包文件（相对路径原样保留）。 */
  #snapshotTargets(): string[] {
    const targets = [DRAFT_HTML, DRAFT_QUERIES];
    if (this.hasAppManifest()) targets.push(DRAFT_APP_MANIFEST);
    for (const file of this.bundleFiles()) targets.push(file.path);
    return targets;
  }

  /** GATE 时的快照（交付物全集；缺省的文件记为缺省）。 */
  snapshot(round: number): void {
    const dir = this.path(path.join('snapshots', `round-${round}`));
    rmSync(dir, { recursive: true, force: true });
    this.#ensureSubdir(dir);
    for (const name of this.#snapshotTargets()) {
      const source = this.path(name);
      if (!existsSync(source)) continue;
      const target = path.join(dir, name);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  }

  /** 回滚到某次 GATE 的快照（快照里缺省的文件在当前目录里也删掉）。 */
  restore(round: number): void {
    const dir = this.path(path.join('snapshots', `round-${round}`));
    if (!existsSync(dir)) throw new Error(`widget draft snapshot round-${round} is missing`);
    for (const name of this.#snapshotTargets()) {
      const source = path.join(dir, name);
      if (existsSync(source)) {
        mkdirSync(path.dirname(this.path(name)), { recursive: true });
        copyFileSync(source, this.path(name));
      } else {
        this.remove(name);
      }
    }
  }

  writeReport(kind: 'check' | 'review', round: number, report: WidgetCheckReport | unknown): void {
    this.write(
      path.join('reports', `${kind}-${round}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }

  readReport(round: number): WidgetCheckReport | null {
    const text = this.read(path.join('reports', `check-${round}.json`));
    if (text === null) return null;
    try {
      return JSON.parse(text) as WidgetCheckReport;
    } catch {
      return null;
    }
  }

  /** 整个草稿目录删除（交付成功后）。 */
  destroy(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * 过期草稿清理（core 启动时对全部 Bot、每次新建制作时对该 Bot）：manifest 的
 * `updatedAt`（读不到就用目录 mtime）早于 TTL 的草稿整目录删除。`skip` 里的 craftId
 * （正在进行的制作）不动。返回删除数。
 */
export function sweepExpiredDrafts(input: {
  paths: AppPaths;
  now: number;
  botId?: string;
  skip?: ReadonlySet<string>;
  ttlMs?: number;
}): number {
  const ttl = input.ttlMs ?? WIDGET_CRAFT_DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000;
  const botIds =
    input.botId !== undefined ? [input.botId] : listDirs(path.join(input.paths.home, 'bots'));
  let removed = 0;
  for (const botId of botIds) {
    const root = botWidgetDraftsDir(input.paths, botId);
    for (const craftId of listDirs(root)) {
      if (input.skip?.has(craftId) === true) continue;
      const dir = path.join(root, craftId);
      const draft = WidgetDraft.open(input.paths, botId, craftId);
      let updatedAt = draft?.tryReadManifest()?.updatedAt;
      if (updatedAt === undefined) {
        try {
          updatedAt = statSync(dir).mtimeMs;
        } catch {
          continue;
        }
      }
      if (input.now - updatedAt > ttl) {
        rmSync(dir, { recursive: true, force: true });
        removed += 1;
      }
    }
  }
  return removed;
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** 包内文件的 MIME 粗判（按扩展名；真正的一致性由交付侧与 CSP 承担）。 */
function mimeOfPath(rel: string): string {
  const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'css':
      return 'text/css';
    case 'js':
    case 'mjs':
      return 'text/javascript';
    case 'json':
      return 'application/json';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'svg':
      return 'image/svg+xml';
    case 'webp':
      return 'image/webp';
    case 'woff2':
      return 'font/woff2';
    case 'txt':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}

/** queries.json 的文本 → 条目（缺省 / 空为 []；JSON / 形状不合法为 null）。 */
function parseQueries(text: string | null): WidgetQueryDef[] | null {
  if (text === null || text.trim() === '') return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const defs: WidgetQueryDef[] = [];
  for (const item of raw) {
    const parsed = widgetQueryDefSchema.safeParse(item);
    if (!parsed.success) return null;
    defs.push(parsed.data);
  }
  return defs;
}
