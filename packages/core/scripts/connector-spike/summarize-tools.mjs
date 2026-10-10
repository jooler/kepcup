#!/usr/bin/env node
// D73 适配辅助（NOT product code）：汇总 packages/core/test/fixtures/connectors/*.tools.json 的
// 工具数、注解覆盖率与风险分布，列出缺注解 / 判定来源不是注解的工具。风险分档直接用产品里的
// `classifyRiskDetailed`（@kepcup/shared，需先 `pnpm --filter @kepcup/shared build`），与应用实际行为一致：
// 只读 / 写 / 破坏性；来源 annotation（server 注解）/ name（按名字推断或名字否决）/ default（缺省取严）。
//
//   node packages/core/scripts/connector-spike/summarize-tools.mjs [slug …] [--list]
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '../../test/fixtures/connectors');
const sharedDist = path.resolve(here, '../../../shared/dist/index.js');

export function summarize(tools, classifyRiskDetailed) {
  const buckets = { read: [], write: [], destructive: [] };
  const notFromAnnotation = [];
  for (const tool of tools) {
    const { risk, source } = classifyRiskDetailed({
      name: tool.name,
      annotations: tool.annotations,
    });
    buckets[risk].push(tool.name);
    if (source !== 'annotation') notFromAnnotation.push(`${tool.name}(${risk}/${source})`);
  }
  const withHints = tools.filter(
    (t) =>
      t.annotations?.readOnlyHint !== undefined || t.annotations?.destructiveHint !== undefined,
  ).length;
  return { total: tools.length, withHints, buckets, notFromAnnotation };
}

const out = (line) => process.stdout.write(`${line}\n`);

async function main() {
  const shared = await import(pathToFileURL(sharedDist).href).catch(() => null);
  if (!shared) {
    console.error('先运行 `pnpm --filter @kepcup/shared build`。');
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const list = args.includes('--list');
  const wanted = args.filter((a) => !a.startsWith('--'));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.tools.json')).sort();
  for (const file of files) {
    const slug = file.replace(/\.tools\.json$/, '');
    if (wanted.length > 0 && !wanted.includes(slug)) continue;
    const tools = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
    const { total, withHints, buckets, notFromAnnotation } = summarize(
      tools,
      shared.classifyRiskDetailed,
    );
    out(
      `${slug}: ${total} 个工具；带风险注解 ${withHints}/${total}；只读 ${buckets.read.length}、写 ${buckets.write.length}、破坏性 ${buckets.destructive.length}`,
    );
    if (notFromAnnotation.length > 0) {
      out(`  判定不来自注解（需人工看）: ${notFromAnnotation.join(', ')}`);
    }
    if (list) {
      for (const key of ['destructive', 'write', 'read']) {
        out(`  ${key}: ${buckets[key].join(', ')}`);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
