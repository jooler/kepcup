# Pi Agent 1.4.0 升级实施文档（不含 pi-durable）

> 状态：**已实施**（2026-10-22，实施记录见 [docs/dev/PROGRESS.md](../docs/dev/PROGRESS.md)「Pi Agent 1.4.0 升级」；未提交）。
>
> 基线：`packages/core` 的四个 pi 包锁定 `1.0.2`。
>
> 目标：`@earendil-works/pi-agent-core` / `pi-ai` / `pi-coding-agent` / `pi-mcp` 统一升级到 **`1.4.0`**。
>
> 关联文档：
> - [docs/dev/04-agent-runtime.md](../docs/dev/04-agent-runtime.md)
> - [docs/design/09-tech-stack.md](../docs/design/09-tech-stack.md)
> - [docs/dev/PROGRESS.md](../docs/dev/PROGRESS.md)
> - [todo/pi-1x-upgrade-mcp-subagent.md](pi-1x-upgrade-mcp-subagent.md)（1.0.2 升级与 MCP/SubAgent 历史）
>
> **非目标（本文件明确不做）：**
> - 不引入 `@earendil-works/pi-durable`。
> - 不迁移 SubAgent、任务压缩、durable journal 或任务状态机。
> - 不重构 `PiEngine` / `TaskHost` / `orchestrator` 的架构。
> - 不删除本地 MCP 策略、审批、回执、SSE 传输。
> - 不做任何 DB 迁移。

---

## 0. 新对话如何推进

1. 先读 §1–§4。**只做 P0，不要顺手做架构重构。**
2. 按 §4 的顺序执行，每完成一项勾选对应复选框。
3. 迭代中只跑定向测试；全量 `pnpm test` 只在 §7 的收口点跑一次。
4. 如果遇到 P0 之外的编译/测试问题：
   - 先判断是不是 1.4.0 的真实行为变化；
   - 记录到 `docs/dev/PROGRESS.md` 或 `docs/dev/DEVIATIONS.md`；
   - 不要为了“顺手修”扩大改动面。
5. 完成后按 §10 更新文档，并在 `docs/dev/PROGRESS.md` 记录证据。
6. 不要提交（用户未要求提交时）。

---

## 1. 结论与升级范围

### 1.1 静态兼容结论

对 1.0.2 / 1.4.0 的 tarball 做过 `.d.ts` 对照，并扫描本地全部 pi import：

| 包 | 本地使用导出数 | 1.4.0 缺失 |
|---|---:|---:|
| `pi-agent-core` | 2 | 0 |
| `pi-ai` | 15 | 0 |
| `pi-coding-agent` | 11 | 0 |
| `pi-mcp` | 17 | 0 |
| `pi-mcp/oauth` | 20 | 0 |

**符号层面没有删除型 breaking。** 已知的类型不兼容只有一处：

```text
src/mcp/tools.ts: Argument of type 'CallToolResult' is not assignable to
parameter of type '{ structuredContent?: Record<string, unknown> }'
```

原因是 1.4.0 把 `CallToolResult.structuredContent` 从 `Record<string, unknown>` 改成了 `unknown`（MCP 2026-07-28 允许数组、`null`、原始值）。

### 1.2 本次升级的实际改动面

必改：

1. 四个包版本号 + lock + `pnpm-workspace.yaml` 的 release-age 例外。
2. `mcpReceiptOf` 的 `structuredContent` 类型与普通对象判断。
3. `wrapPiTool` 对 1.4.0 `read` 图片 block 的映射（当前会被丢弃）。
4. 定向测试与全量回归。

建议但非阻塞：

1. `SseTransport.send()` 接受 `{ signal }`，避免超时/取消后仍把请求发出去。
2. `createModels()` 增加 KepCup 的 `identity`（否则默认以 pi 身份发 User-Agent / attribution）。
3. Azure 旧 model ref 的数据兼容检查（代码里没有引用，但用户设置里可能有）。
4. `read` 图片的 resize/模型提示是否要传 `ctx.model`（见 §11）。

**不做：** 任何 `pi-durable`、SubAgent、compaction 重写，或 `runs`/`run_steps` 迁移。

---

## 2. 目标版本与依赖事实

### 2.1 版本

| 包 | 本地 | 目标 |
|---|---:|---:|
| `@earendil-works/pi-agent-core` | 1.0.2 | **1.4.0** |
| `@earendil-works/pi-ai` | 1.0.2 | **1.4.0** |
| `@earendil-works/pi-coding-agent` | 1.0.2 | **1.4.0** |
| `@earendil-works/pi-mcp` | 1.0.2 | **1.4.0** |

四个包都要求 Node `>=22.19.0`，与根 `package.json` 一致。

### 2.2 传递依赖变化

- `pi-ai@1.4.0` 新增 `@earendil-works/pi-telemetry@1.4.0`。
- `pi-ai@1.4.0` 使用 `openai@7.19.0`。
- `pi-coding-agent@1.4.0` 新增 `@earendil-works/pi-codemode@1.4.0`、`@earendil-works/pi-mcp@1.4.0`、`@earendil-works/pi-tui@1.4.0`，以及 `quickjs-wasi`。
- `pi-coding-agent@1.4.0` 仍精确依赖 `undici@8.10.2`；本地 `pnpm-workspace.yaml` 的 `overrides.undici: 8.11.2` 继续生效，升级后必须确认 lock 中只有一个 undici。

### 2.3 与本项目相关的 1.4.0 变化

- `pi-ai`：新增 `ClientIdentity`、telemetry、classifier 模型；Azure provider 从 `azure-openai-responses` 改名 `azure`；跨模型切换时丢弃思考块，不再转成 `<thinking>` 文本。
- `pi-agent-core`：新增 `identity`、`durationMs`；本地使用的 `Agent` / `AgentTool` 不变。
- `pi-coding-agent`：
  - `read` 对图片返回 image block；
  - `bash` 结构化输出包含 `exit_code`、`full_output_path`、`wall_time_seconds`；
  - 新增 `output-files`（写到 OS 临时目录）；
  - compaction 摘要改用模型输出上限，`generateSummary()` 的 `reserveTokens` 被忽略；
  - 新增 `hiddenTools`、`formatSkillsForPrompt(..., 'indirect')`；
  - 不再导出 `./client`、`./experimental/plugin`（本项目未使用）。
- `pi-mcp`：
  - `CallToolResult.structuredContent` 变为 `unknown`；
  - `McpTransport.send(message, { signal })` 新增可选取消信号；
  - transport / OAuth / 关闭时序修复；
  - 仍然不支持 legacy HTTP+SSE，本地 `SseTransport` 保留。

---

## 3. 开工前检查

- [x] `git status` 干净；新建分支，例如 `t/pi-1.4-upgrade`。 （新建分支 `t/pi-1.4-upgrade`；开工前另有未跟踪 todo 文档，不影响实施）
- [x] 确认当前四个包版本为 `1.0.2`：

  ```bash
  grep -n '"@earendil-works/pi-' packages/core/package.json
  ```

- [x] 确认 `pnpm-workspace.yaml` 的 `overrides.undici: 8.11.2` 存在。
- [x] 决定 release-age 策略（见 §4.2）：
  - **推荐**：等 `1.4.0` 过了仓库的 minimum release age 再装；
  - 如果现在必须装：接受在 `minimumReleaseAgeExclude` 里显式列出本次升级的包，并在 PR/记录里写明理由。
- [x] 记录当前基线，不重跑全量：
  - 最近一次 `pnpm test` / `pnpm typecheck` 结果可从 `docs/dev/PROGRESS.md` 取。
  - 只跑本文件 §7.1 的定向基线。

---

## 4. P0：版本升级与必改项

### 4.1 修改四个包版本

文件：`packages/core/package.json`

```json
"@earendil-works/pi-agent-core": "1.4.0",
"@earendil-works/pi-ai": "1.4.0",
"@earendil-works/pi-coding-agent": "1.4.0",
"@earendil-works/pi-mcp": "1.4.0"
```

- [x] 只改这四个依赖，不动其他依赖。 （core 四个包；`app-validator` 的 `pi-mcp` 按验收标准同步，见 DEV-041）

### 4.2 安装与 lockfile

```bash
pnpm install
```

预期：

- `pnpm-lock.yaml` 更新；
- `pnpm-workspace.yaml` 可能自动追加 `minimumReleaseAgeExclude`：
  - `@earendil-works/pi-agent-core@1.4.0`
  - `@earendil-works/pi-ai@1.4.0`
  - `@earendil-works/pi-codemode@1.4.0`
  - `@earendil-works/pi-coding-agent@1.4.0`
  - `@earendil-works/pi-mcp@1.4.0`
  - `@earendil-works/pi-telemetry@1.4.0`
  - `@earendil-works/pi-tui@1.4.0`

说明：`1.4.0` 于 2026-10-21 发布，安装时触发了仓库的 release-age 策略；pnpm 会把新包加入例外。**这些例外需要提交**，否则后续 `pnpm install` 会在 supply-chain 校验处失败。若选择等待 release age，则不要保留这些例外，等窗口过后重新安装。

- [x] 确认 lock 中没有 `@earendil-works/pi-*@1.0.2` 残留。
- [x] 确认 undici 单实例：

  ```bash
  pnpm why undici
  # 期望：Found 1 version of undici（8.11.2）
  ```

- [x] 确认 `pi-coding-agent` 新增依赖已进 lock（`pi-codemode`、`pi-telemetry`、`quickjs-wasi`）。

### 4.3 类型检查，确认唯一已知错误

```bash
pnpm --filter @kepcup/shared run build
pnpm --filter @kepcup/core run typecheck
```

预期先看到：

```text
src/mcp/tools.ts(...): error TS2345:
Argument of type 'CallToolResult' is not assignable to parameter of type
'{ structuredContent?: Record<string, unknown> | undefined; }'.
```

### 4.4 修 `structuredContent` 类型与普通对象判断

文件：`packages/core/src/mcp/tools.ts`

当前签名（1.0.2 假设）：

```ts
export function mcpReceiptOf(
  result: { structuredContent?: Record<string, unknown> },
  textParts: readonly string[],
)
```

改为接受 `unknown`，并且只把 **普通对象** 当作回执来源：

```ts
export function mcpReceiptOf(
  result: { structuredContent?: unknown },
  textParts: readonly string[],
): { url?: string; externalId?: string } | null {
  const structured = result.structuredContent;
  let source: Record<string, unknown> | null =
    structured !== null &&
    typeof structured === 'object' &&
    !Array.isArray(structured)
      ? (structured as Record<string, unknown>)
      : null;
  // 其余逻辑不变
}
```

要求：

- 数组、`null`、字符串、数字都**不**作为回执来源；
- 不抛错、不影响工具结果；
- 纯文本块里的 JSON 回退路径保持不变。

文件：`packages/core/src/apps/ui/service.ts`

`toUiToolResult` 目前会 `JSON.stringify` 任意 `structuredContent`，再 `JSON.parse as Record`。1.4.0 下需要：

- 先判断是普通对象（非 `null`、非数组）；
- 非普通对象时**省略** `structuredContent`，只保留文本块；
- 不要把它包装成数组或 `{ value: ... }`，除非产品明确要求。

`packages/core/src/apps/connections.ts` 的 `jsonOfToolResult` 已把结果当 `unknown`，并会在下游 `jsonPath` 判断对象，**无需改动**。

- [x] 修改 `mcp/tools.ts`。
- [x] 修改 `apps/ui/service.ts`（普通对象判断）。
- [x] 检查全部 `structuredContent` 使用点：

  ```bash
  grep -rn "structuredContent" packages/core/src
  ```

- [x] 增加单元测试（`packages/core/test/unit/mcp-tools.test.ts`）：
  - `structuredContent: [..]` → `null` 回执、不抛错；
  - `structuredContent: null` / `'text'` / `42` → `null`；
  - `structuredContent: { url, id }` → 仍能取回执；
  - 纯文本 JSON 回退仍生效。
- [x] 增加 UI 单元测试（`packages/core/test/unit/app-ui-service.test.ts`）：
  - 数组 / `null` / 原始值 → `structuredContent` 被省略；
  - 普通对象 → 仍透传（脱敏后）。

### 4.5 修 `wrapPiTool` 的图片结果

文件：`packages/core/src/tools/coding-tools.ts`

1.4.0 的 `read` 对图片返回：

```ts
[
  { type: 'text', text: 'Read image file [image/png]' },
  { type: 'image', data: '<base64>', mimeType: 'image/png' },
]
```

当前 `wrapPiTool` 只拼接 `block.type === 'text'`，图片会被丢掉。需要：

- 扩展本地 `PiToolResult` 类型，允许 image block；
- 文本块照旧 `redact` → `spill` / `truncate` → `<untrusted>`；
- image block 收集为 `ToolResult.images`，**不要**把 base64 放进 `<untrusted>` 文本；
- 只有图片、没有文本时，文本内容用固定说明，例如：

  ```text
  （已返回图片，见附加图片）
  ```

- `ToolResult.images` 仍由引擎按模型 `input` 能力决定是否发送（现有行为不变）；
- 图片 block 不参与本地 `ToolOutputSpill` 的文本落盘。

参考类型：

```ts
type PiContentBlock = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
};

type PiToolResult = {
  content: PiContentBlock[];
  details?: { fullOutputPath?: string };
  isError?: boolean;
};
```

建议实现顺序：

```ts
const textParts: string[] = [];
const images: Array<{ mimeType: string; base64: string }> = [];
for (const block of result.content ?? []) {
  if (block.type === 'text' && typeof block.text === 'string') {
    textParts.push(block.text);
  } else if (
    block.type === 'image' &&
    typeof block.data === 'string' &&
    typeof block.mimeType === 'string'
  ) {
    images.push({ base64: block.data, mimeType: block.mimeType });
  }
}
const rawText = textParts.join('\n').trim();
const redacted = secrets.redact(rawText);
// spill / truncate 仅作用于 redacted 文本
const body = ...;
return {
  ok: result.isError !== true,
  content: `<untrusted>\n${body || '（已返回图片，见附加图片）'}\n</untrusted>`,
  ...(images.length > 0 ? { images } : {}),
  ...(result.isError === true ? { errorCode: 'COMMAND_FAILED' } : {}),
};
```

关于 `full_output_path`：

- 本轮**不**把上游 `details.fullOutputPath` 接进本地 spill 或模型文本；
- 上游 `bash` 的文本里已经包含完整输出路径；
- 本地 `ToolOutputSpill` 仍是任务大输出的唯一落盘路径（workspace 内、随 run 清理）。

- [x] 修改 `wrapPiTool`。
- [x] 在 `packages/core/test/unit/coding-tools-wrap.test.ts` 增加：
  - 伪造 read 定义返回 text + image；
  - 断言 `ToolResult.images` 有 1 项、base64/mimeType 正确；
  - 断言文本仍是 `<untrusted>` 包裹，且不含 base64；
  - 只有 image、无 text 时，文本为固定说明；
  - `isError: true` 时仍映射 `COMMAND_FAILED`。
- [ ] 如有真实的图片 fixture，增加一条集成/手工验证：图片模型下 `read` 能收到图片；text-only 模型下图片被引擎丢弃并保留说明。 （未执行：无真实图片 fixture；已用伪造 image block 单测覆盖）

### 4.6 `SseTransport.send()` 接受取消信号（建议）

文件：`packages/core/src/mcp/sse-transport.ts`

1.4.0 的 `McpTransport.send` 签名变为：

```ts
send(message: JsonRpcMessage, options?: { signal?: AbortSignal }): Promise<void>
```

本地实现少一个可选参数，TypeScript 仍能通过，但超时/取消后可能继续 dispatch。建议：

```ts
import { McpAbortError } from '@earendil-works/pi-mcp';

async send(
  message: JsonRpcMessage,
  { signal }: { signal?: AbortSignal } = {},
): Promise<void> {
  if (signal?.aborted === true) throw new McpAbortError();
  if (!this.#started || this.#closed || this.#endpoint === null) {
    throw new McpConnectionClosedError();
  }
  const combined = signal
    ? AbortSignal.any([this.#controller.signal, signal])
    : this.#controller.signal;
  const response = await this.#fetch(this.#endpoint, {
    // ...
    signal: combined,
  });
  // ...
}
```

注意：

- `AbortSignal.any` 需要 Node 22+，项目满足；
- 只让取消影响本次 dispatch，不关闭整个 transport；
- 不要把所有 abort 都转换成连接关闭，否则会误触发重连。

- [x] 修改 `send()`。
- [x] 增加/补充测试：发送前已 abort、发送中 abort、正常发送三种情况。
- [x] 跑 `packages/core/test/integration/mcp.test.ts` 确认 legacy SSE 路径无回归。

### 4.7 可选：显式声明 KepCup 的 identity

文件：`packages/core/src/agent/models.ts`

1.4 的 `createModels()` 支持：

```ts
createModels({
  credentials: credentialStore,
  identity: {
    userAgent: 'detailed',
    attribution: { name: 'KepCup', url: 'https://kepcup.app' },
  },
});
```

当前未设置时，pi-ai 默认以 pi 身份发送 attribution。是否改成 KepCup 是产品决定，不是升级阻塞项。

- [x] 决定是否加；如果加，补一条请求头/identity 单元测试。 （本轮决定不加，见 DEV-042）
- [x] 如果加，记录到 `docs/dev/PROGRESS.md`。 （不适用：本轮未加 identity）

### 4.8 Azure 旧 model ref 检查

1.4.0 把 provider `azure-openai-responses` 改名为 `azure`。

- [x] 代码扫描：

  ```bash
  grep -rn "azure-openai-responses" packages apps --include='*.ts' --include='*.svelte'
  ```

  当前预期为空。

- [x] 检查已有设置/数据是否可能保存旧 provider id：

  ```bash
  # 只读检查本地开发数据，不要提交
  grep -rn "azure-openai-responses" <数据目录>/settings.json <数据目录>/*.json 2>/dev/null
  ```

- [x] 如果有旧 ref：记录为数据兼容问题，按既有策略报 `NOT_FOUND` 或后续加别名；**本次不自动迁移**。 （不适用：代码与本地数据均无旧 provider id）

---

## 5. P1：升级后核对的行为变化

这些不是必须改代码，但必须在测试/手工验证中确认。

### 5.1 跨模型 thinking 行为

- 1.4.0 在模型变化时丢弃其他模型的 thinking block，不再转 `<thinking>` 文本。
- 现有 `packages/core/test/integration/model-switch.test.ts` 在 dry-run 中通过。
- 建议补一个手工/集成断言：同一对话切换 provider 后，请求体不包含上一模型的 thinking 文本。

### 5.2 compaction 摘要参数

- `pi-coding-agent` 的 `generateSummary()` 已忽略 `reserveTokens`。
- 本地当前**没有**调用上游 `generateSummary`（使用自己的 `TaskContextCompactor` + `complete()`），因此无代码影响。
- 如果未来复用上游 compaction，注意 `TASK_CONTEXT_SUMMARY_OUTPUT_TOKENS` 不再对应上游行为。

### 5.3 bash 输出结构

- 1.4.0 的 bash 文本可能包含 `Full output: <path>`，`details.fullOutputPath` 也有值。
- 本地 `wrapPiTool` 只取文本，因此 `full_output_path` 不会丢（已在文本中）。
- 本地 `ToolOutputSpill` 仍优先；不要同时写两份落盘文件。

### 5.4 MCP resources

- 1.4.0 的 coding-agent MCP 扩展不再在连接时枚举 resources；本地只使用 `readResource`，不受影响。
- 不要因为升级去改本地 MCP 资源读取逻辑。

### 5.5 模型目录增删

- 1.4.0 的内置模型目录继续有增删。
- 已保存的失效 model ref 仍按 `NOT_FOUND` 处理；不做自动迁移。
- 升级后跑一次设置页“模型选择/测试连接”手工 smoke。

### 5.6 `durationMs`

- `pi-ai` / `pi-agent-core` 新增 assistant / tool result 的 `durationMs`。
- 本地当前不消费；不影响现有 step 持久化。后续可用于状态行耗时，不在本次范围。

---

## 6. 不要做的事

- [x] 不新增 `@earendil-works/pi-durable`。
- [x] 不改 `agent/subagent.ts`、`agent/context/compaction.ts` 的架构。
- [x] 不把 `runs` / `run_steps` 迁移到别的表。
- [x] 不删除 `mcp/sse-transport.ts`。
- [x] 不替换本地 `tool-output-spill.ts` 为上游 `output-files`（上游写 OS 临时目录，不满足 workspace/run 清理要求）。
- [x] 不把 `pi-coding-agent` 的 `./client` / `./experimental/plugin` 当作可用 API（1.4 已移除）。
- [x] 不使用 coding-agent 的深路径 helper（例如 `extensions/mcp/tools`）作为公共 API；如确需，先在本文件记录例外。

---

## 7. 测试计划

### 7.1 定向测试（迭代中）

```bash
# 类型与核心行为
pnpm --filter @kepcup/shared run build
pnpm --filter @kepcup/core run typecheck

# MCP 结果与回执
node scripts/run-tests.mjs run \
  packages/core/test/unit/mcp-tools.test.ts \
  packages/core/test/unit/app-ui-service.test.ts \
  packages/core/test/unit/coding-tools-wrap.test.ts

# MCP 连接 / 循环 / SSE
node scripts/run-tests.mjs run \
  packages/core/test/integration/mcp.test.ts \
  packages/core/test/integration/mcp-loop.test.ts

# 任务压缩 / 子代理 / 模型切换
node scripts/run-tests.mjs run \
  packages/core/test/unit/context-compaction.test.ts \
  packages/core/test/unit/subagent.test.ts \
  packages/core/test/integration/model-switch.test.ts

# 事件与 session id
node scripts/run-tests.mjs run \
  packages/core/test/integration/agent-end-transcript.test.ts \
  packages/core/test/integration/opencode-session-header.test.ts
```

### 7.2 全量回归（收口时只跑一次）

```bash
pnpm typecheck
pnpm lint
pnpm test
```

- [x] 全量通过；如有失败，先单跑该文件复核，区分环境基线 / 真实回归。
- [x] 如果需要验证打包产物，跑一次 `pnpm build`，确认 `pi-codemode` / `quickjs-wasi` / `pi-telemetry` 被正确打包。
- [x] e2e 只在本次改动触及跨包构建或运行时行为时跑；纯 core 依赖升级可留到最终交付前统一跑。 （纯 core 依赖升级，e2e 按任务书留到最终交付前统一跑；本轮未跑）

### 7.3 建议补充的测试

- [x] `mcp-tools.test.ts`：非对象 `structuredContent`。
- [x] `app-ui-service.test.ts`：非对象 `structuredContent`。
- [x] `coding-tools-wrap.test.ts`：read 返回 image block。
- [x] `mcp.test.ts`：legacy SSE 发送取消/超时（如果改了 `send`）。
- [ ] 手工：图片模型 `read` 图片、text-only 模型 `read` 图片的降级说明。 （待人工：需要真实图片模型 / text-only 模型）
- [ ] 手工：设置页选择模型 / 测试连接；多 provider 切换。 （待人工：需要真实模型 Key 与设置页 UI）

---

## 8. 验收标准

- [x] `packages/core/package.json` 四个包精确为 `1.4.0`。
- [x] `pnpm-lock.yaml` 无 `@earendil-works/pi-*@1.0.2` 残留。
- [x] `pnpm why undici` 只有一个版本（8.11.2）。
- [x] `pnpm --filter @kepcup/core run typecheck` 通过。
- [x] `pnpm lint` 通过。
- [x] 定向测试通过；全量 `pnpm test` 在收口时通过。
- [x] `mcpReceiptOf` 对数组 / `null` / 原始值不抛错、不误判。
- [x] `toUiToolResult` 对非对象 `structuredContent` 安全省略。
- [x] `wrapPiTool` 不再丢 read 图片；`ToolResult.images` 正确。
- [x] 没有新增 `pi-durable` 依赖。
- [x] `docs/dev/PROGRESS.md` 记录了版本、测试证据、偏差。
- [x] `docs/design/09-tech-stack.md` 版本同步到 `1.4.0`。
- [x] `docs/dev/04-agent-runtime.md` 如涉及行为变化已同步。

---

## 9. 回滚

1. 还原 `packages/core/package.json` 四个版本到 `1.0.2`。
2. 还原 `pnpm-lock.yaml`。
3. 移除本次新增的 `minimumReleaseAgeExclude` 条目（如果回滚到 1.0.2）。
4. 还原代码改动：
   - `packages/core/src/mcp/tools.ts`
   - `packages/core/src/apps/ui/service.ts`
   - `packages/core/src/tools/coding-tools.ts`
   - `packages/core/src/mcp/sse-transport.ts`
   - 对应测试
5. `pnpm install`，然后：

   ```bash
   pnpm --filter @kepcup/shared run build
   pnpm --filter @kepcup/core run typecheck
   ```

**无需 DB 回滚**：本次升级没有迁移本地 `runs` / `run_steps` / `main` 表。

---

## 10. 文档更新清单

- [x] `docs/dev/PROGRESS.md` 新增小节：
  - 标题：`Pi Agent 1.4.0 升级（2026-10-22，不含 pi-durable）`
  - 版本、传递依赖、release-age 例外；
  - `structuredContent` 修复；
  - `wrapPiTool` 图片映射；
  - SSE cancel signal（如做）；
  - 定向 / 全量测试证据；
  - 任何偏差（identity、Azure、图片 resize）。
- [x] `docs/design/09-tech-stack.md`：pi 版本从 `1.x` / `1.0.2` 更新为 `1.4.0`。
- [x] `docs/dev/04-agent-runtime.md`：
  - 如 `wrapPiTool` 行为变化，补充“read 图片结果映射”；
  - 如加 identity，补充模型请求身份说明。
- [x] `docs/dev/DEVIATIONS.md`：如有新的偏差（例如不接 `fullOutputPath`、identity 选择、Azure 旧 ref 处理），按既有格式记录。
- [x] `todo/pi-1x-upgrade-mcp-subagent.md`：在开头或 Phase A 处加一行说明“1.0.2 的升级记录见历史；后续升级到 1.4.0 见 `todo/pi-1.4-upgrade.md`”。

---

## 11. 风险与开放问题

1. **release-age 例外**
   - `1.4.0` 发布不足 release-age 窗口，pnpm 会把它加入 `minimumReleaseAgeExclude`。
   - 这是供应链策略的显式例外，必须在提交/评审中说明；不要悄悄删掉策略。

2. **pi-coding-agent 新增依赖**
   - `pi-codemode` + `quickjs-wasi` 会进入安装树；即使不用 codemode，也可能影响打包体积。
   - 收口时做一次 `pnpm build`，确认 Electron 打包不因 wasm/worker 路径失败。

3. **read 图片的模型信息**
   - 1.4 的 `read` 使用 `ctx.model.inputLimits` 做图片 resize/提示；本地 `wrapPiTool` 只传 `{ cwd }`，没有 `model`。
   - 结果是使用 fallback resize，且 `getNonVisionImageNote` 可能不触发。
   - 这不阻塞升级；如果需要精确的 resize 限制，再扩展 `WrapOptions` 传 `model`。先记录为 P2。

4. **`structuredContent` 语义**
   - 1.4 允许数组 / `null` / 原始值；不要把非对象强制转成对象。
   - 回执和 MCP Apps UI 都要按“只有普通对象才展示/提取”处理。

5. **Azure 旧 ref**
   - 代码没有旧 provider 引用，但用户数据可能有。
   - 本次不做自动迁移；如果确认有存量，另开数据兼容任务。

6. **上游 API 仍在变化**
   - 本次只锁 `1.4.0`，不要顺手升级到更高版本。
   - 1.4.0 的 API 与 1.0.2 相比主要是增量；但 `pi-coding-agent` 的 MCP/compaction/output 代码仍在快速演进，后续升级需重新评估。

7. **不要为了“用上新特性”扩大范围**
   - identity、classifier、telemetry、output-files、pi-durable 都不在本次必做项。
   - 本次目标是“安全升级 + 保持现有行为”。

---

## 附录 A：dry-run 证据（2026-10-22）

在临时 worktree 中做过一次升级演练：

1. 只把四个包改为 `1.4.0`，`pnpm install` 成功。
2. `pnpm --filter @kepcup/shared run build` 成功。
3. `pnpm --filter @kepcup/core run typecheck` 只有一处错误：

   ```text
   src/mcp/tools.ts(420,69): error TS2345:
   Argument of type 'CallToolResult' is not assignable to parameter of type
   '{ structuredContent?: Record<string, unknown> | undefined; }'.
   ```

4. 按 §4.4 把 `mcpReceiptOf` 改为接受 `unknown` 并只接受普通对象后，core typecheck 通过。
5. 定向测试 81 例通过：

   ```text
   context-compaction.test.ts        7 passed
   mcp-tools.test.ts                 8 passed
   coding-tools-wrap.test.ts         5 passed
   subagent.test.ts                 25 passed
   agent-end-transcript.test.ts      1 passed
   opencode-session-header.test.ts   6 passed
   mcp.test.ts                      18 passed
   mcp-loop.test.ts                 11 passed
   ```

6. 全量 core 测试通过：

   ```text
   Test Files  377 passed | 1 skipped (378)
   Tests       4120 passed | 23 skipped (4143)
   Duration    216.39s
   ```

7. `pnpm why undici` 只有 `8.11.2` 一个版本。

说明：dry-run 只覆盖 core 包，没有跑 desktop / e2e / 打包；正式实施仍需按 §7 收口。

---

## 附录 B：预计改动文件索引

必改：

- `packages/core/package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`（release-age 例外）
- `packages/core/src/mcp/tools.ts`
- `packages/core/src/tools/coding-tools.ts`
- `packages/core/test/unit/mcp-tools.test.ts`
- `packages/core/test/unit/coding-tools-wrap.test.ts`

建议/视情况：

- `packages/core/src/apps/ui/service.ts`
- `packages/core/test/unit/app-ui-service.test.ts`
- `packages/core/src/mcp/sse-transport.ts`
- `packages/core/test/integration/mcp.test.ts`
- `packages/core/src/agent/models.ts`（identity）
- `docs/dev/PROGRESS.md`
- `docs/design/09-tech-stack.md`
- `docs/dev/04-agent-runtime.md`
- `docs/dev/DEVIATIONS.md`
- `todo/pi-1x-upgrade-mcp-subagent.md`（仅加指引）

不要改：

- `packages/core/src/agent/subagent.ts`
- `packages/core/src/agent/context/compaction.ts`
- `packages/core/src/dispatch/tasks.ts`
- `packages/core/src/dispatch/orchestrator.ts`（除非升级直接暴露编译问题）
- `packages/core/src/mcp/service.ts`（除非 `McpTransport.send` 适配需要）
- `packages/core/src/agent/tool-output-spill.ts`
