import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FAKE_ACP_AGENT_BIN } from '../src/fake-acp-launch.js';

/**
 * 守卫：子进程假 Agent（bin/fake-acp-agent.mjs）靠 Node 内置的类型擦除直接
 * 加载 src/fake-acp-agent.ts。擦除只对 node_modules 之外的文件生效，且不做
 * `.js` → `.ts` 的相对路径解析、不支持需要转译的 TS 语法——这里锁住这些前提。
 */
const source = fileURLToPath(new URL('../src/fake-acp-agent.ts', import.meta.url));

describe('fake ACP agent subprocess entry', () => {
  it('lives outside node_modules (type stripping does not apply there)', () => {
    expect(source.split(/[\\/]/)).not.toContain('node_modules');
    expect(FAKE_ACP_AGENT_BIN.split(/[\\/]/)).not.toContain('node_modules');
  });

  it('has no relative imports and no non-erasable TypeScript syntax', () => {
    const text = readFileSync(source, 'utf8');
    expect(text).not.toMatch(/from\s+['"]\.\.?\//);
    expect(text).not.toMatch(/import\s*\(\s*['"]\.\.?\//);
    expect(text).not.toMatch(/^\s*(export\s+)?(const\s+)?enum\s/m);
    expect(text).not.toMatch(/^\s*(export\s+)?namespace\s/m);
    // Parameter properties (constructor(private x: T)) need a transform.
    expect(text).not.toMatch(/constructor\([^)]*\b(private|public|protected|readonly)\s/);
  });
});
