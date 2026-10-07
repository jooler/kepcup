#!/usr/bin/env node
/**
 * stdio ↔ Streamable HTTP 转发（docs/design/28-external-agents-acp.md §4.4，D72）：
 * 给只支持 stdio MCP 的智能体用——Agent 以 stdio server 启动本脚本，脚本把每条
 * JSON-RPC 消息 POST 到宿主 MCP 桥，再把响应写回 stdout。由 Electron 自带的
 * Node 运行（`ELECTRON_RUN_AS_NODE=1`），无第三方依赖。
 *
 * 环境变量：`KEPCUP_MCP_URL`（桥地址）、`KEPCUP_MCP_TOKEN`（会话 token，不走
 * 命令行参数以免出现在进程列表里）。
 *
 * P2：本期接入的智能体都支持 http MCP，代理先实现 + 单测，尚未接线（P4 打包时
 * 随应用分发，P5 遇到只支持 stdio 的智能体时接入）。
 */
import { createInterface } from 'node:readline';

const url = process.env.KEPCUP_MCP_URL;
const token = process.env.KEPCUP_MCP_TOKEN;
if (!url || !token) {
  process.stderr.write('kepcup mcp proxy: KEPCUP_MCP_URL and KEPCUP_MCP_TOKEN are required\n');
  process.exit(2);
}

let sessionId = null;
const pending = new Set();

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeRaw(json) {
  const parsed = JSON.parse(json);
  for (const message of Array.isArray(parsed) ? parsed : [parsed]) write(message);
}

/** Parses an SSE body and forwards every `data:` event as one message. */
function forwardSse(text) {
  let data = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    } else if (line.length === 0 && data.length > 0) {
      writeRaw(data.join('\n'));
      data = [];
    }
  }
  if (data.length > 0) writeRaw(data.join('\n'));
}

async function forward(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const id = Array.isArray(message) ? null : (message.id ?? null);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        ...(sessionId !== null ? { 'mcp-session-id': sessionId } : {}),
      },
      body: line,
    });
    const issued = response.headers.get('mcp-session-id');
    if (issued !== null) sessionId = issued;
    const body = await response.text();
    if (!response.ok) {
      if (id !== null) {
        write({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: `bridge HTTP ${response.status}: ${body.slice(0, 200)}` },
        });
      }
      return;
    }
    if (body.trim().length === 0) return; // 202 for notifications
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) forwardSse(body);
    else writeRaw(body);
  } catch (error) {
    if (id !== null) {
      write({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: `bridge unreachable: ${error?.message ?? String(error)}` },
      });
    }
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (line.trim().length === 0) return;
  // Concurrent: a long tools/call must not block other requests.
  const task = forward(line).finally(() => pending.delete(task));
  pending.add(task);
});
input.on('close', () => {
  void Promise.allSettled([...pending]).then(() => process.exit(0));
});
