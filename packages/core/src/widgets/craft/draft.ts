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
  type WidgetCheckReport,
  type WidgetCraftManifest,
  type WidgetQueryDef,
} from '@kepcup/shared';
import { botWidgetDraftDir, botWidgetDraftsDir, type AppPaths } from '../../infra/paths.js';
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

/** 快照覆盖的文件（交付物本身）。 */
const SNAPSHOT_FILES = [DRAFT_HTML, DRAFT_QUERIES] as const;

/** 交付物的摘要（回执关卡的比对对象）。 */
export interface DraftDigest {
  htmlSha256: string;
  queriesSha256: string;
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

  /**
   * 当前交付物的摘要：HTML 是原文的 sha256（与 WidgetService 落库同口径），查询是
   * `queries.json` 里合法条目的规范摘要（缺省 / 无法解析 = 按无查询计；这种草稿的 GATE
   * 会因 `query.invalid` 判定阻断，不会留下可交付的回执）。
   */
  digest(): DraftDigest {
    const html = this.read(DRAFT_HTML) ?? '';
    return {
      htmlSha256: createHash('sha256').update(html).digest('hex'),
      queriesSha256: queriesSha256Of(this.queries() ?? []),
    };
  }

  /**
   * 交付物：只读一次，摘要就按读到的这份字节算（同 {@link digest} 口径）；`queries` 为 null =
   * queries.json 不合法（这种草稿不会有可交付回执）。
   */
  deliverable(): { html: string; queries: WidgetQueryDef[] | null; digest: DraftDigest } {
    const html = this.read(DRAFT_HTML) ?? '';
    const queries = parseQueries(this.read(DRAFT_QUERIES));
    return {
      html,
      queries,
      digest: {
        htmlSha256: createHash('sha256').update(html).digest('hex'),
        queriesSha256: queriesSha256Of(queries ?? []),
      },
    };
  }

  /** `queries.json` 的条目（缺省为 []；JSON / 形状不合法为 null）。 */
  queries(): WidgetQueryDef[] | null {
    return parseQueries(this.read(DRAFT_QUERIES));
  }

  /** GATE 时的快照（index.html + queries.json；缺省的文件记为缺省）。 */
  snapshot(round: number): void {
    const dir = this.path(path.join('snapshots', `round-${round}`));
    rmSync(dir, { recursive: true, force: true });
    this.#ensureSubdir(dir);
    for (const name of SNAPSHOT_FILES) {
      if (this.exists(name)) copyFileSync(this.path(name), path.join(dir, name));
    }
  }

  /** 回滚到某次 GATE 的快照（快照里缺省的文件在当前目录里也删掉）。 */
  restore(round: number): void {
    const dir = this.path(path.join('snapshots', `round-${round}`));
    if (!existsSync(dir)) throw new Error(`widget draft snapshot round-${round} is missing`);
    for (const name of SNAPSHOT_FILES) {
      const source = path.join(dir, name);
      if (existsSync(source)) copyFileSync(source, this.path(name));
      else this.remove(name);
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
