import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 模型选取只有一个入口（agent/llm-router.ts 的 builtinModelRef）。业务代码里
 * 手写 `runtime.model || settings.default*` 会让某个调用点漏掉「设置改了就
 * 立即生效」——这里把允许直接读这些字段的文件钉死，新增调用点请走
 * routeFor / builtinModelRef / LlmRouter。
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

const PATTERN = /\b(defaultMainModel|defaultLightModel|runtime\??\.(model|light_model))\b/;

/** 允许直接引用的文件（相对 src）及原因。 */
const ALLOWED = new Map<string, string>([
  ['agent/llm-router.ts', '唯一的选取逻辑'],
  ['domain/bots.ts', 'Bot 创建：是否指定了模型'],
  ['start.ts', '装配：首启默认值 / 外部 Agent 兜底的启动期判断'],
  ['handover/adapters/model.ts', 'D88 移交：复制 / 改写 Bot 的模型配置值（不做选取）'],
  ['settings/adapters.ts', 'D89 设置目录适配器：读 / 改默认模型与 Bot 模型的配置值（不做选取）'],
  ['rpc/settings-bindings.ts', 'D89 settings.changed：按字段 diff 推出受影响的设置项（不做选取）'],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('model selection has a single source', () => {
  it('only the allow-listed files read the default / per-bot model fields', () => {
    const offenders = walk(SRC)
      .map((file) => path.relative(SRC, file))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => !rel.includes('npx-lockfiles'))
      .filter((rel) =>
        readFileSync(path.join(SRC, rel), 'utf8')
          .split('\n')
          .some(
            (line) =>
              !line.trimStart().startsWith('*') &&
              !line.trimStart().startsWith('//') &&
              PATTERN.test(line),
          ),
      );
    expect(offenders).toEqual([]);
  });
});
