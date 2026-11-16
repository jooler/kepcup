# P4 · 内置官方插件与收口

> 状态：**已实施（2026-11-15，工作区未提交；与 P1–P3 同在 `feat/plugin-platform`）** · 依赖：P1–P3 · 分支：`feat/plugin-platform`（单集成分支，任务书原定 `feat/capability-plugins/p4-builtin-plugins` 不再单独开分支）
> 必读：[60 号设计 §决策 12 / §9](../../docs/design/60-capability-model-plugins.md)、内置第一方插件目录（`plugins/`，参照 im-wechat 的包结构与 [plugins/im-wechat/README.md](../../plugins/im-wechat/README.md)）、[51 §15](../../docs/design/51-plugin-system.md)（收口回写先例）

## 1 目标

两个内置数据型官方插件（阿里云百炼 / 火山方舟）作为机制 dogfood 与后续新模型发布载体；全量测试收口一次；文档回写与设计偏差确认。

## 2 范围

| 包含 | 不包含 |
|---|---|
| `plugins/` 新增「阿里云百炼」「火山方舟」插件（manifest + 图标，纯数据） | 存量 `settings.modelProviders` vendor 实例迁移（原样保留，双路径并存） |
| 市场索引条目（官方 verified） | `VENDOR_DESCRIPTORS` / presets 删除或瘦身（不动） |
| 全量 `pnpm test` 收口一次 | 新引擎实现（本期无新协议） |
| 60 号补「现状」节、16 号补「插件条目」指引 | 60 §10 Q1–Q4 的任何落地 |

## 3 开工前核对

```bash
git log --oneline -3
ls plugins/   # 内置插件包结构参照
rg "DEV-" DEVIATIONS.md | tail -5
```

## 4 步骤

### 步骤 1：内置插件包

1. `plugins/dashscope/`（展示名「阿里云百炼」）：manifest——`id:'io.kepcup/dashscope'`（与既有内置插件 id 规则对齐，以 `plugins/` 现有包为准）、`usage` 必填（1–500 字启用说明）、`instances:['capability-model']`、`contributions.capabilityModels` = 现描述符 `presets` 全量迁移为条目（wan 系列、qwen-image 系列、tts、asr、embedding、video 逐 preset 一条；`capability` 按描述符能力矩阵、`engine:'dashscope'`、`displayName` 中文、视频/图片特有默认进 `params`——**只迁描述符已有信息，不发明新默认值**）。
2. `plugins/volcengine-ark/`（「火山方舟」）：同构，`engine:'volcengine-ark'`，presets 迁移（方舟无 rerank/tts/asr，条目只含 image/video/embedding 等）。
3. 图标复用 `assets/provider-icons/` 现有厂商图标（随包拷贝）；`VENDOR_DESCRIPTORS` 与 `PROVIDER_TEMPLATES.vendor` **原样保留**。
4. 内置插件不入 `plugins` 表（只读目录型，D104 既有机制），确认投影后 `plugins.listCapabilityEntries` 能看到两插件条目。

### 步骤 2：市场条目

官方插件索引（`dl.kepcup.com/plugins/v1` 的索引源——随应用仓库的索引生成流程，参照现有内置插件上架方式）加两条目，tier verified；本步骤只做仓库内索引源与打包钩子，发布动作走既有 release 流程。

### 步骤 3：全量收口

```bash
pnpm test   # 全量一次（阶段收口允许，AGENTS.md）
```

失败只单跑该文件复核（不连续多轮全量）。

### 步骤 4：文档回写

1. 60 号设计补「§11 现状（D124 收口后）」——仿 51 §15：列实际落地与 §决策 的差异（含迁移实际号、DEV 偏差索引）。
2. [16 号](../../docs/design/16-capability-models.md)加「插件条目」小节：一段话指向 60 号 + 「新增厂商两条路」（内置引擎随发版 / 官方插件发条目）。
3. README.md（design）60 号索引行状态从「草案，待评审」改「已实施（日期）」（若评审通过）；决策表 D124 行同步。

## 5 验收

- [x] 两个内置插件在 builtin 来源（开发 / e2e 只读目录投影）安装可见、条目可勾选、条目解析链可用。证据：两包 `validate` 0 error、`pack` 通过（dashscope 6108 B / volcengine-ark 11084 B）；`plugin-builtin-capability-models.test.ts` 6 用例（builtin 加载 / 摘要带实例声明 / registry.isConsumable / listCapabilityEntries 分组 20+7 条并与 `VENDOR_DESCRIPTORS.presets` 逐模型核对 / setBotCapabilityEntries 勾选与拒绝 / entriesFor 解析 / testCapabilityEntry 零实例定位）。
- [ ] 市场安装形态的凭据可配、测试连接通过、真机冒烟（百炼图 + 方舟视频各一次成功出图/出片）**待用户验证**：builtin 来源因 `plugin_instances.plugin_id` 外键引用 `plugins(id)`（D104 内置插件不入该表）不能持有实例（DEV-112 定界）；市场安装会写入 `plugins` 表，实例与外键因此成立。本环境无 API Key，真机冒烟不阻塞开发收口；插件详情对 builtin 来源不渲染账号实例区（显示市场安装边界说明），避免入口可点但保存必失败。
- [x] 60 号「验收锚点」五条逐条核对通过。证据：逐条核对表见 P4 报告（安装→实例→勾选→出图 = P2 `plugin-capability-model.test.ts` 端到端用例 + 真机待用户；卸载回退 = 同文件「卸载后回退全局槽位」；INSTANCE_AMBIGUOUS / 凭据卡 = `media-entry-resolution.test.ts` + P3 `setup-alias.test.ts`；usage 扩列 = `media-service-usage.test.ts`；零变化护栏 = 本节第 4 条）。
- [x] 全量 `pnpm test` 全绿（一次）。证据：`Test Files 794 passed | 3 skipped (797)`；`Tests 8508 passed | 44 skipped (8552)`（2026-11-15，Duration 180s，exit 0；失败 0，未单跑复核）。
- [x] 未装/未启用插件环境与改造前行为一致（P2 护栏测试在收口复跑仍绿）。证据：`media-adapters / media-service / media-tools / media-delivery` 四护栏 95→119 用例（含 engines / entry-resolution / usage 同批）全绿；settings 四护栏（settings-catalog 35 / settings-item-writes 38 / settings-adapters-coverage 6 / card-components）全绿；`git diff` 未触碰 `VENDOR_DESCRIPTORS` / `ADAPTERS` / settings-catalog / `media/http.ts`。
- [x] 文档回写完成（60 §现状、16 指引、README 状态）。证据：60 号新增「§11 现状（D124 收口后）」（仿 51 §15：落地面 / 内置插件与市场 / 偏差索引 DEV-093..103、111、112）；16 号新增「插件条目（D124）」节（指向 60 号 + 新增厂商两条路）；docs/design/README.md 60 号索引行与决策表 D124 行状态改为「已实施 2026-11-15」（真机验收待用户执行）；DEVIATIONS.md DEV-111 / DEV-112。

## 6 实施记录

- 分支 / 提交：`feat/plugin-platform`（单集成分支，未 commit；提交由主代理负责）。
- 实际迁移号：无新迁移（0075 已在 P1 落地；本阶段零 schema 变更）。
- DEV 偏差汇总：
  1. **DEV-111** shared `pluginContributionKindSchema` 收编 `'capability-model'`（市场索引 `categoriesOf` 分支、`categories` max 5→6、概述「N 个模型；可添加多个厂商账号」、renderer 类别徽标与 market category i18n 两键）——任务书「市场条目」的流程配套面，im-wechat `im` 分支先例；schema 未收编的旧客户端逐条跳过，低于 `0.5.14` 的客户端由 `engines` 标为不可安装。
  2. **DEV-112** builtin 只读目录插件的条目通路补齐（`manifestOf` builtin 回退 / `isConsumable` builtin 恒真 / `summaries` 带实例供给声明 / `start.ts` `pluginInstalled` 认 builtin——超出任务书点名的 `listCapabilityEntries` 一处的同根缺口）+ **实例面定界**（`plugin_instances` 外键 ⇒ builtin 不能持有实例，`#pluginForInstances` 保持 NOT_FOUND，凭据 / 测试连接 / 真机走市场安装路径；能力模型详情对 builtin 隐藏账号实例区，市场安装形态正常展示；生产构建无 builtin 目录，全部新分支不可达、行为零变化）。
  3. 条目 id slug 化（`PLUGIN_MCP_KEY_PATTERN` 不含点号：`wan2.7-t2v` → 条目 id `wan2-7-t2v`，厂商模型 id 原样进 `model` 字段）——schema 约束的必然，非偏差，已写进两包 README。
- 与任务书步骤的差异声明（完整）：
  - 步骤 1.1 `id:'io.kepcup/dashscope'`：以 `plugins/` 现有包为准采用了 D125 参考插件的 `io.kepcup` 前缀（`app.kepcup` 是市场首批 18 包的历史前缀，两命名空间均合法，`PLUGIN_RESERVED_NAMESPACES` 只保留 com/local）。
  - 步骤 1.4「凭据可配、测试连接通过」在 builtin 只读目录形态下**结构性不可达**（外键约束，DEV-112）；该验收项的完整闭环以市场安装形态为准（真机待用户验证），builtin 形态以「投影可见 / 可勾选」收口（集成测试证据）。
  - 步骤 2 市场条目：仓库内索引源 = `scripts/sign-plugin-index.mjs`（categoriesOf 分支 + 一次性密钥 dry-run 签名验证，产物 `categories: ["capability-model"]`、概述、engines 正确）+ `plugins/README.md` 批次清单记录（tier 建议 verified、catalog 行样例）；curation `catalog.json` 是发布期文件不入库（既有惯例），发布动作（生产密钥 / R2 / deploy）未执行。
  - 步骤 3 全量：`pnpm test` 一次通过（8508 passed / 44 skipped / 0 failed），无单跑复核需求；playwright e2e 不在 `pnpm test` 范围（`copyShippedPlugins` 夹具会带上两个新 builtin 包，e2e 断言如有精确计数需在下次 e2e 跑批时观察——登记为遗留观察项）。
- 遗留与建议：
  - 真机冒烟（百炼 `qwen-image` 出图 + 方舟 `doubao-seedance-2-0-260128` 出片）待用户在桌面端从市场安装两插件后执行并回填 60 §11。
  - embedding / rerank 条目已在 Bot 勾选 UI 按 P3 既有分组展示（声明不消费，60 §10 Q4）；若用户反馈困惑，可在 UI 侧加「暂不生效」徽标（属 Q4 立项范围，本期不动）。
  - builtin 形态的实例支持需先解 `plugin_instances` 外键（独立迁移），现阶段无需求（生产不分发 builtin）。
