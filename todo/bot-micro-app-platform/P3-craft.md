# P3 制作流程升级与生态前身

> 设计依据：55 号 §6.1（写作知识分层 / `micro_app_sdk_inspect`）、§11（制作流程升级 / 检查器规则）、§14 P3、§15 验收第 11、12 条。
> 验收：非一线模型经制作流程交付的语音微应用无阻断、可通过 S2 全流程（mock ASR / 模型 / 播报离线整轮）；修改已有微应用能引用最近诊断；基准 13 条（含 3 条语音 / 对话），门槛「无阻断交付 ≥8/10」。

## 任务清单

### 1. craft loop 多文件 + 清单（55 §11）

- [ ] 草稿目录增 `micro-app.json` + 多文件（`assets/` 等）；BUILD/FIX 可写集合扩展；`widget_template` 升级为包骨架模板（语音陪练 / 表单 / 看板三模板，能被清单校验器解析并跑通 S2）。
- [ ] SPEC 阶段必答：能力清单与理由、**联网用途与失败降级**（net=open 保留要写用途）、降级路径、每轮对话成本估算；修改已有微应用时先读最近 24h 诊断进需求。
- [ ] GATE：清单校验（`app.manifest-invalid`）、权限最小性（`app.permission-overbroad`）、SDK 一致性（只调声明能力 `app.permission-undeclared`）、资源路径与体积、`app.fallback-missing`（声明任何宿主能力但无文本回退 → warning，通用化）、`app.cost-estimate-missing`、`app.capability-unavailable`（+ 设置深链）、`app.sdk-deprecated`、`app.net-open-default`。
- [ ] REVIEW 增：儿童内容安全、隐私（录音 / 外传）、成本、无麦克风降级。
- [ ] DELIVER：写清单 + 包 + 用量预算；卡片展示网络范围与能力清单（P0 卡片能力复用）。
- [ ] S2 预览：宿主能力 mock——`ai.chat` 返回脚本化回复（fixtures 或内置脚本）、`media.listen` 注入 fixture 转写、`media.speak` 记录不发声；跑通「一轮完整对话」验收步骤；`net.fetch` 失败归 `preview.offline-network`。

### 2. 写作知识分层 + 自省（55 §6.1）

- [ ] `sdk.md` 入口（≤4KB，信任边界第一段）+ `references/`（每能力 1–3KB：完整契约 / 错误码 / 限额 / 可复制示例）+ `templates/` + `.d.ts`；守卫测试进 CI（大小 / 引用存在 / 模板可解析可预览 / `.d.ts` 重生成无 diff / 检查器引用的 API 名都在 spec）。
- [ ] 制作 loop 工具 `micro_app_sdk_inspect`（按名取契约，≤2KB；未知名返回可用方法列表；结果进 loop 历史不进主对话）。

### 3. 基准

- [ ] 基准需求 13 条（10 存量 + 3 语音 / 对话：口语陪练整轮、打断降级、进度恢复）；门槛「无阻断交付 ≥8/10」；基准 runner 与记录。

### 4. 测试与收口

- [ ] core：craft 多文件状态机、检查器全部新规则、S2 mock、inspect 工具、基准脚本。
- [ ] 收口：定向 + 全量一次；子代理审查一轮。

## 实施记录

（阶段收口时填写。）
