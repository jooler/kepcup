# P4 · 内置官方插件与收口

> 状态：**待实施** · 依赖：P1–P3 · 分支：`feat/capability-plugins/p4-builtin-plugins`
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

- [ ] 两个内置插件安装可见、条目可勾选、凭据可配、测试连接通过（真机冒烟：百炼图 + 方舟视频各一次成功出图/出片）。证据：
- [ ] 60 号「验收锚点」五条逐条核对通过。证据：
- [ ] 全量 `pnpm test` 全绿（一次）。证据：
- [ ] 未装/未启用插件环境与改造前行为一致（P2 护栏测试在收口复跑仍绿）。证据：
- [ ] 文档回写完成（60 §现状、16 指引、README 状态）。证据：

## 6 实施记录

- 分支 / 提交：
- 实际迁移号 / DEV 偏差汇总：
- 遗留与建议：
