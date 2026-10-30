# 48 Bot 模板导出/导入（Bot Template）

用户可以把一个 Bot 导出为**模板文件**（单个 `*.kepcup-bot.json`），分享给其他用户快速套用，或在自己另一台设备上恢复。模板只含「能力 + 人设」；对话、记忆、知识库、任务、组件与一切密钥**永不包含**。导入 = 从模板**新建一个 Bot**（不覆盖已有 Bot）。

相关：[03-bot.md](03-bot.md)（Profile）、[05-wiki-and-skills.md](05-wiki-and-skills.md)（技能）、[37-bot-asset-handover.md](37-bot-asset-handover.md)（D88 资产移交——在线 Bot→Bot 复制，本设计是它的离线文件版）、[29-connected-apps.md](29-connected-apps.md)（连接应用）、[23-mcp-and-subagent.md](23-mcp-and-subagent.md)（MCP）、[14-models-and-browser.md](14-models-and-browser.md)（浏览器资料）。

**状态：已实施**（v0.3.0）。无数据库迁移——模板是纯文件，导入复用现有 `bots` / `bot_skills` 表与 `BotsService.create` 管线。

## 决策

- **模板是单个 JSON 文件**，带 `format: 'kepcup-bot-template'` 与 `version: 1`；未知版本导入直接拒绝（明确报错，不猜语义）。契约在 `packages/shared/src/domain/bot-template.ts`（`botTemplateSchema`），导入在边界处 zod 全量校验（仓库惯例：磁盘上的配置在边界校验）。
- **包含**：清洗后的完整 Profile（identity / persona / role / boundaries / behavior / runtime 子集）、自写技能（authored，文件全量内嵌 base64，status 照搬）、头像（`upload:` 内嵌字节，`preset:` 标识直接保留）、已导入技能清单（仅 name + sourceUrl）。
- **头像遮罩**：`avatarMask` 只在上传头像且遮罩为 `rounded` 时写入（缺省 = `circle`，旧模板无这一项照样能读，不升版本号）；导入时建完 Bot 再写 `bots.avatar_mask`。
- **不包含**（与 D37 移交的「永不移交」清单同源）：对话（conversations / messages / attachments…）、记忆（`bots/{id}/memory.db`）、知识库（`bots/{id}/wiki/`）、任务（runs / todos / schedules / watches / delegations / jobs）、组件（widgets 四表）、密钥（secrets 表永不出现在导出路径上）、路径与应用写授权、审批与审计记录、浏览器登录态、workspace 目录。
- **唯一需要字段级清洗的位置是 `profile.runtime` 的本机引用**：`mcp_server_ids` / `app_connection_ids`（指向本机全局配置的 id，别的设备无意义）、`browser_profile`（本机共享资料）、`inkcop_agent_keys`（同机协作）、`network_allowlist`（可能含内网域名）、`message_transport`（已废弃恒空）。保留：`model` / `light_model`（模型偏好，空 = 跟随设置默认）、`network_policy`、`agent` 的 effort / permission / **capabilities**（18 个宿主能力包是应用级语义，可移植）。**导出侧清洗一次，导入侧再强制清洗一次**（防御纵深：无论模板里残留什么都清空）。
- **导入只新建 Bot**：`BotsService.create(profile, { skipDefaultAgent: true })`（模板带空模型 / Agent = 跟随设置默认，不被 onboarding 默认外部 Agent 覆盖，与 D88 同语义）。外部智能体引擎 id 在本机不可用（实验开关关闭或不在目录）时回退内置引擎（`id` / `model` 清空，permission / capabilities 保留）。
- **技能**：自写技能走 staging → `parseSkillDir` 校验（SKILL.md frontmatter 的 name 必须与条目名一致）→ `promoteAuthored`（真实 git 提交到新 Bot 的自写技能仓库）→ 按 status `activateAuthored` / `parkAuthored`。单个技能失败**跳过并报告，不回滚 Bot**。已导入技能**不安装**（内容在本机 git 技能库里，凭 sourceUrl 重拉需要走 skill_import 审批流），导入结果里列清单由 UI 提示用户自行重新导入。
- **限额（超限报错，不静默截断）**：自写技能 ≤ 20 个、每技能 ≤ 32 文件、单文件 ≤ 256KB、每技能 ≤ 1MB、模板序列化 ≤ 4MB、inspect 读取 ≤ 8MB。
- **防篡改**：导入采用 MCPB 模式——`bots.templateInspect` 返回文件 sha256，确认后 `bots.templateImport` 必须回传同一 sha256，文件被替换则拒绝。技能内文件路径在 schema（拒绝绝对路径 / `..` / `.git` / `node_modules`）与写盘（resolve 后必须落在 staging 内）双层校验，防路径穿越。
- **导出文件名**：`{bot-name}.kepcup-bot.json`（`botTemplateFileName` 清洗）。

## 文件格式

```jsonc
{
  "format": "kepcup-bot-template",
  "version": 1,
  "exportedAt": 1760000000000,      // epoch ms
  "profile": { /* 完整 botProfileSchema，runtime 本机引用已清空 */ },
  "avatar": { "mime": "image/png", "base64": "…" },   // 可选：upload 头像字节
  "avatarMask": "rounded",                          // 可选：上传头像遮罩，缺省 / 缺项 = "circle"
  "skills": {
    "authored": [                    // 自写技能，文件 base64 内嵌
      { "name": "weekly-report", "status": "active", "files": [{ "path": "SKILL.md", "base64": "…" }] }
    ],
    "imported": [                    // 仅清单：提示用户自行重新导入
      { "name": "deploy", "sourceUrl": "https://example.com/deploy.git" }
    ]
  }
}
```

同一技能在任何机器上导出的文件序按字节序排序，内容相同 → 字节相同 → sha256 相同。

## RPC（`bots.template.*`，均入 APP_METHODS）

| 方法 | 入 | 出 |
|---|---|---|
| `bots.templatePreview` | `{ botId }` | 导出确认页摘要：人设 / 职责 / 边界 / 模型 / 技能数 / 头像 + 将剥离的本机引用计数 |
| `bots.templateExport` | `{ botId, path }` | `{ path, bytes, counts }`（临时文件 + rename 原子写） |
| `bots.templateInspect` | `{ path }` | `{ sha256, 摘要 }` |
| `bots.templateImport` | `{ path, sha256 }` | `{ botId, installedSkills, failedSkills, skippedImportedSkills }` |

实现：`packages/core/src/domain/bot-templates.ts`（`BotTemplateService`），绑定在 `packages/core/src/rpc/bindings.ts` 的 bots 域。导入成功后发 `bot.updated`（通讯录自动刷新）。

信任模型说明：`bots.templateExport` 接受渲染层给出的**任意路径**并写入模板文件（与 `mcpb.install` 接受任意路径读取同级）。桌面端该路径来自系统保存对话框；远程配对端点（D96）在「配对设备 ≡ 本机用户」的信任模型下同样可调用，无额外限制——配对确认本身就是这条边界的授权。写入内容限于 core 自行序列化的模板 JSON，不接受任意文件内容；但会**覆盖**目标路径已有的文件（与系统保存对话框语义一致），原文件内容不保留。

已知边界（留作产品决策）：技能市场安装的**公共技能**（`public_skills`，全局行）不进模板、不在预览/导入摘要中提示——依赖公共技能的 Bot 在新设备上这些能力静默缺失，需用户自行从市场安装。

## UI

- **导出**：右栏 Bot 详情「配置」tab 底部「导出为模板」→ 预览确认框（将包含 / 不包含 / 本机配置剥离三段，剥离项按实际计数列出）→ 系统保存对话框（新增 `dialog:saveFile` 主进程通道，全库首个 `showSaveDialog`；只传路径，core 写文件）→ toast 结果。
- **导入**：侧栏「新增」面板「从模板导入」→ 文件选择（复用 `dialog:selectFile`）→ inspect 确认框（摘要 + 已导入技能需自行安装的提示）→ 导入 → toast。
- web 端点（D96 手机 PWA）无本地文件对话框：两个入口按 `endpointSupports('local-file-dialog')` 置灰不隐藏。
- 文案 zh-CN / en-US 同步补齐（`botTemplate.*`）。

## 测试

`packages/core/test/unit/bot-templates.test.ts`（Rig 模式）：清洗不变量、头像内嵌 / preset 保留 / 脏值丢弃、自写技能跨设备往返（真实 git 提交）、已导入技能只列清单（含 library_id 缺失）、sha256 防替换、未知版本 / 非法 JSON / 路径穿越拒绝、单技能失败跳过不回滚、导入侧强制清洗残留引用、限额（jsonBytes 超限拒绝、目录缺失跳过、写盘失败不产生半截文件）。
