import { describe, expect, it } from 'vitest';
import { connectRejectionText, safeFetch } from '../../src/infra/safe-dispatcher.js';

/**
 * 真实连接期校验（不 mock undici）：`safeFetch` 必须与 `undici.fetch` + 共享 Agent
 * 配套使用——把外部 undici Agent 传给全局 fetch 会因版本接口漂移直接
 * `UND_ERR_INVALID_ARG`（本轮审查发现的 P1）。localhost 解析到环回，连接前被
 * lookup 拒绝，证明防线在真实 fetch 链路上生效且没有 DNS rebinding 窗口。
 */
describe('safeFetch 真实连接链路（D125 P4）', () => {
  it('主机名解析到回环 → 连接期拒绝（拒绝原因可沿 cause 链还原）', async () => {
    expect(typeof globalThis.fetch).toBe('function');
    const error = await safeFetch('http://localhost:18081/x.png').then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).not.toBeNull();
    expect(connectRejectionText(error)).toMatch(/内网|保留/);
  });

  it('IP 字面量私网在发起请求前拒绝（错误信息带固定前缀）', async () => {
    await expect(safeFetch('http://127.0.0.1:18081/x.png')).rejects.toThrow(/内网|保留/);
  });
});
