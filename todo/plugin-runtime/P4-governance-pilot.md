# P4 · 治理管线与百炼文生图执行型试点

> 状态：**待实施** · 依赖：本方案 P1–P3 · 分支：`feat/plugin-runtime/p4-governance-pilot`
> 必读：[61 号设计 §7 / §8](../../docs/design/61-plugin-runtime-platform.md)、[51 号 §安装管线/市场](../../docs/design/51-plugin-system.md)、[16 号逐厂商 API 参考](../../docs/design/16-capability-models.md)（百炼文生图协议事实）、`packages/core/src/media/adapters/dashscope.ts`（协议现成实现，本试点的对照物）

## 1 目标

治理自动化落地（同意卡能力披露 UI、市场 CI 静态扫描钩子），并用首个执行型官方插件——**阿里云百炼文生图（`plugins/dashscope-t2i/`）**——走通「安装 → 配置 → Bot 绑定 → 运行 → 反馈 → 产物」全链路作为 D125 收口 dogfood。

**试点定位（重要）**：百炼文生图协议与内置 `dashscope` 引擎**同源**（wan 系列异步：`X-DashScope-Async` 提交 + `GET /api/v1/tasks/{id}` 轮询），内置引擎已能跑通同能力。试点**有意**在插件内重新实现该协议（经 `host.net.fetch`），目的是 A/B dogfood 执行型运行时的全路径（提交/轮询/进度/取消/错误映射/产物落附件），而非补能力空白。收口时在实施记录里给出 A/B 结论（两条路径的行为与观测差异），并就「参考插件保留为样例 or 退役」给出建议——该去留是用户决策，不在本阶段自行定。

## 2 范围

| 包含 | 不包含 |
|---|---|
| 同意卡能力披露 UI（联网域名 / 凭据字段 / 存储配额） | community 执行型开放（Q4） |
| 市场 CI 静态扫描钩子（native/eval/远程动态 require/白名单一致性） | 索引服务端新机制（沿用 D104 签名/撤销） |
| `plugins/dashscope-t2i/` 执行型试点（wan 异步文生图协议，插件内自带实现） | 试点插件正式上架运营（走既有 release 流程） |
| A/B dogfood 记录（执行型路径 vs 内置引擎路径） | `host.secrets.set`（Q1；若试点证实必需，只记入 61 §11 修订建议） |
| 全量 `pnpm test` 收口一次 | 任何新引擎/新契约 |
| 61 号补「现状」节、51 号 §15 回写 | — |

## 3 开工前核对

```bash
git log --oneline -3
rg "DEV-" DEVIATIONS.md | tail -5
node scripts/run-tests.mjs run packages/core/test/unit/plugin-host.test.ts   # P2 基线绿
rg "X-DashScope-Async" packages/core/src/media   # 协议对照实现定位
```

## 4 步骤

### 步骤 1：同意卡能力披露

安装同意卡（D104 既有组件）对含 `runtime` 清单增渲染区：「可联网域名」清单（逐条列出，含通配说明）、「将请求的凭据」字段名列表（不含值）、「本地存储」配额说明；更新时清单扩大 → 重新同意（D104 既有 diff 机制延伸）。文案口径与 D104 一致（能力 = 事实披露，不做安全承诺措辞）。

### 步骤 2：市场 CI 扫描钩子

官方插件索引构建流程（现有 CI）对含 `runtime` 的包逐版本加静态扫描步骤（Node 脚本，结果进构建产物状态）：

1. 文件面：`.node` / `.wasm` / 可执行位 / symlink 逃逸 → fail；
2. 代码面（对打包 JS 文本）：`eval(`/`new Function(`/`require('child_process')`/`process.binding`/`Worker(`/非白名单动态 `import(` → fail；
3. 白名单一致性：提取包内字符串中的 `https?://host` 与 `network.allow` 比对，未知域 → warn（人工复审）；
4. 结果写入索引条目（复用 tier/状态机制），fail 不出包。

### 步骤 3：`plugins/dashscope-t2i/` 执行型试点插件

1. manifest：`id:'io.kepcup/dashscope-t2i'`、展示名「百炼文生图（执行型试点）」、`runtime:{entry:'dist/main.js', hostApi:'^1', network:{allow:['dashscope.aliyuncs.com']}}`、`instances:['capability-model']`、实例字段 `{apiKey: sensitive, required}`、`contributions.capabilityModels` 一条 image 条目（`model` 取 16 号 wan 系列预置 id、**不填 `engine`**、`params` 带默认 size/n）。
2. 实现（SDK，协议以 `dashscope.ts` 与 16 号文档为准）：`generateImage` = 组参（`model/prompt/size/n/seed`，prompt 顶层 `input.prompt`）→ `host.net.fetch` POST（`X-DashScope-Async: enable`）拿 `task_id` → 轮询 `GET /api/v1/tasks/{task_id}`（2s 间隔，状态机 PENDING/RUNNING→SUCCEEDED/FAILED 映射）→ `host.progress` 上报（排队/生成中 + 百分比估算）→ 返回 `output.results[].url`（下载落附件由 core 做）；`host.signal` 取消 = 尽快返回（服务端任务自然过期，不做删除调用）。
3. 错误映射：401 → `PROVIDER_AUTH_FAILED`、402/配额词 → `PROVIDER_QUOTA`、429 → `PROVIDER_RATE_LIMITED`、其余 → `PROVIDER_UNAVAILABLE`（与人话文案表对齐）。
4. 真机验收：Bot 绑定条目 → `generate_image` 一条真实出图 → 进度阶段可见（排队/生成中）→ 产物落附件 → 活动抽屉全记录 → 插件卡 busy→ready。
5. **A/B 对照**：同 prompt/size 分别走插件条目与内置引擎全局槽位各一次，记录差异（延迟/错误文案/活动记录形态）进实施记录。

### 步骤 4：全量收口与文档回写

```bash
pnpm test   # 全量一次（阶段收口，AGENTS.md）
```

1. 61 号补「§12 现状（D125 收口后）」——仿 51 §15：实际落地与决策差异、迁移实际号、DEV 偏差索引、试点 A/B 结论。
2. 51 号 §15 增「运行时平台」小节指向 61；design/README 61 号索引行状态改「已实施（日期）」（评审通过后）。
3. AGENTS.md / docs/dev 若需补「执行型插件开发指引」链接（指向 SDK README），最小增量。

## 5 验收

- [ ] 同意卡对执行型插件显示三项披露；更新扩权触发重新同意。证据：
- [ ] CI 扫描钩子对违规样例包 fail（样例进测试夹具）、对 reference-media 与 dashscope-t2i 放行。证据：
- [ ] 百炼文生图试点真机全链路一次成功出图 + A/B 对照记录。证据：
- [ ] 全量 `pnpm test` 一次全绿。证据：
- [ ] 61/51 号文档回写完成。证据：

## 6 实施记录

- 分支 / 提交：
- A/B 对照结论（执行型 vs 内置引擎）：
- 实际迁移号 / DEV 偏差汇总：
- 遗留与建议（Q1–Q5 中被试点证实的项、参考插件去留建议）：
