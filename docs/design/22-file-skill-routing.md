# 22 文件技能路由

用户上传了 Bot 当前能力处理不了的文件（PDF、xlsx、epub……）时，Bot 不该直接说「我不认识」。应用随包分发了预置技能市场（P08/D57，含 MinerU 文档解析），GitHub 等公网还有整个 Agent Skills 生态——本文定义模型面对「陌生文件」的完整升级阶梯，以及其中「请求用户授权安装技能」的机制。

## 决策

- **D63 文件技能路由**：模型面对自己处理不了的文件按四级阶梯升级——①已安装技能（既有 `<skills>` 渐进披露）；②应用内置推荐技能：系统提示新增 `<recommended_skills>` 段列出未安装的预置技能（名称/一句话摘要/安装方式），模型匹配后调 `install_skill {preset_id}`，经**阻塞审批** `skill_preset`（卡片展示技能名/摘要/版本/缺失依赖）由用户授权，批准即安装为公共技能并立即可用，拒绝则原 run 继续走下一级；③全网检索：`web_search` 搜技能仓库（Agent Skills 生态），命中后 `install_skill {source_url}` 走既有 `skill_import` 审批流（clone + 静态扫描 + 用户批准）按 Bot 安装；④仍无 → 如实告知用户不支持该文件格式；系统提示注入该阶梯与「不要假装处理过文件」的纪律；无人值守模式下 `skill_preset` 与 `skill_import` 同属自动批准类（内容均落应用自有技能库，无数据目录逃逸，扫描结果记录在卡）；安装成功后 `skills.changed` 发布、`prepareRequest` 每请求刷新系统提示，新技能当次 run 内即可用（见 22）。

## 1 阶梯与用户授权的位置

```
收到附件（上下文行含 id/文件名/mime/大小）
 ① 已安装技能处理                      ← 无新授权
 ② <recommended_skills> 匹配 → install_skill(preset_id)
      └─ 审批卡「安装技能」→ 批准：装为公共技能，继续  → 拒绝：降级
 ③ web_search 检索技能仓库 → install_skill(source_url)
      └─ 审批卡「导入技能」（含静态扫描结果）→ 批准：按 Bot 安装 → 拒绝/无果：降级
 ④ 告知用户：该格式暂不支持（可建议手动安装或换格式）
```

- 授权用**阻塞审批**而非 D58 式「失败 + 重试」：安装是用户决策点（不安装也可能继续聊），run 停在 `waiting_approval`，拒绝后模型收到拒绝结果**继续**执行（降级或答复），体验是「问一句」而不是「失败一次」。
- 预置技能是可信应用内容（发布前经同一静态扫描），所以 ② 的卡片是轻授权（确认即装）；③ 引入任意外部内容，保留完整 `skill_import` 流（扫描 + 风险展示 + 按 Bot 私有安装），授权更重——两级授权强度与内容信任级对齐。

## 2 推荐技能的可见性

- 现状：预置目录只被市场 UI 消费，模型完全不可见；已安装技能经 `<skills>` 注入（名称+描述+SKILL.md 路径）。
- 新增：`SkillPresetsService.promptSection(botId)` 输出**未安装**条目（`<recommended_skills>` 段，置于 `<skills>` 之后）：`id`、技能名、`displayName`、summary（截断）、一行安装指引（`install_skill(preset_id)`）。预置目录是策展的小集合（当前 9 条），整段注入远低于既有 `SKILLS_LIST_TOKEN_BUDGET` 量级；已安装的预置不出现在此段（避免重复诱导安装）。

## 3 install_skill 工具

- `install_skill { preset_id? , source_url? , ref? , reason? }`（二选一，都缺/都给 → INVALID_INPUT）：
  - **preset 路径**：校验存在且未安装（已装 → 直接返回技能位置，幂等）→ `approvals.request('skill_preset', payload)` 阻塞 → 批准 → `SkillPresetsService.install(presetId)` → 返回技能名 + SKILL.md 位置（模型接着 `read` 技能即用）；拒绝 → `APPROVAL_DENIED` 结果，模型降级。
  - **URL 路径**：复用 `SkillImporter` 拆出的 prepare（clone 到临时区 + 静态扫描，产出 `skill_import` 卡 payload）→ 阻塞审批 → 批准 → commit（按 Bot 安装，与现有导入一致）→ 返回位置；扫描判 incompatible 时如实带回原因。
- 审批卡：`skill_preset` 为新增 kind（payload `{presetId, name, displayName, summary, version, missingDeps}`），`ApprovalCard` 增分支（含来源标注「应用内置推荐」）；`describe / renderContextLine / 无人值守自动批准` 同步。`skill_import` 卡与回调沿用，仅把「决定后回调」换成工具内等待。
- 安全边界不变：`install_skill` 只能装进应用技能库（只读、内容寻址）；执行仍走沙箱与网络策略；扫描出的风险照常展示在卡上。

## 4 纪律（提示词）

系统提示新增一小节（静态，位于技能段后）：附件阶梯、**不要假装已读取/处理文件**（没读到内容就说明做不到）、拒绝安装后的行为（降级或如实答复，不重试纠缠）。上下文附件行已含 mime（D61），扩展名是模型匹配推荐技能的主要信号。

## 5 测试锚点

- core 单测：`install_skill` preset 路径（未安装→审批→安装→位置返回；拒绝→APPROVAL_DENIED；已安装幂等）；URL 路径（假 git fixture：扫描 payload、批准后 commit）；`promptSection` 只列未安装、遮蔽规则。
- 审批单测：`skill_preset` 的 describe/上下文行/无人值守自动批准。
- e2e：上传 PDF（mock 场景）→ 推荐卡 → 批准 → Bot 继续处理；拒绝 → Bot 如实答复。

## 6 非目标

- 不做技能相似度向量检索（描述匹配足够）、不做第三方技能市场索引（检索交给模型 + web_search）、不自动安装（永远经审批）、不改 `skill_import` 的既有 RPC 入口。
