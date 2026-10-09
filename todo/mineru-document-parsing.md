# MinerU 文档解析预置技能（实施方案）

> 状态：**已实现（2026-10-04）**。设计依据 [docs/design/17-mineru-document-parsing.md](../docs/design/17-mineru-document-parsing.md)（决策 D57）；实现与测试证据记录在 `docs/dev/PROGRESS.md` 同名小节。

## 1. 背景与目标

Bot 需要读到 PDF（及扫描件、Office 文档、EPUB 等）的原文——OCR、表格、公式保真——并整合进自己的 Wiki。现有能力缺口：

- 预置 `pdf` 技能（pdfplumber/pypdf）只能做纯文本级提取，扫描件、公式、复杂表格无能为力；
- Wiki 入库管线不解析二进制：`wiki_enqueue` 的 attachment/file 来源把原始字节存进 `raw/` 后，维护 loop 对 PDF 只能读到字节流（`inlineTextFor` 返回 null），URL 来源更是直接拒绝二进制（`fetchableTextVerdict`）。

目标：以**预置公共技能**接入官方 MinerU Agent Skill（`opendatalab/MinerU` 仓库 `skills/mineru/SKILL.md`，AGPL-3.0），安装即全体 Bot 可用；Bot 在响应 loop 中用它把 PDF 导出为 Markdown，再经现有 `wiki_enqueue(file)` 管线入库，**核心代码零改动**；引入方式为逐字 vendored，同步脚本跟随官方更新。

## 2. 现状追溯（链路结论）

1. **预置技能链路**：`apps/desktop/resources/preset-skills/` 为市场数据源；`catalog.json`（中文名/摘要/图标/版本/试用语）由 core `SkillPresetsService`（`packages/core/src/skills/presets.ts`）读取；安装走 `parseSkillDir → scanSkillDir → hashDirectory → installPublic`，落入公共作用域；升级靠内容哈希对比 + catalog version 递增。
2. **扫描约束**（`packages/core/src/skills/scan.ts`）：宿主专有能力词（`WebSearch`/`WebFetch`/`mcp__`/`Task 工具`/`SlashCommand`/`BashOutput`/`KillShell`/`VSCode`/`JetBrains`）在 SKILL.md 正文与非二进制文件上检测，命中判 partial——**官方 SKILL.md 全文已逐字核对，全部干净**；网络/凭据风险只查脚本文件（本技能无脚本）；`sandbox:`/`permissions:` frontmatter 官方原文没有。
3. **目录守护测试**（`packages/core/test/unit/preset-skills-catalog.test.ts`）：catalog schema 校验、条目↔目录一一对应、逐条 parse/scan、`scan.name === entry.id`、**description ≤ 300 字符**（随包原创技能的提示词预算约定）、不 incompatible、无沙箱声明、无权限声明、NOTICE 含「原创」。
4. **官方原文的唯一冲突**：description 约 610 字符 > 300。该上限是原创技能的写作约定；官方描述是上游调优过的触发文本，不擅自删节 → 对 vendored 条目放宽到 `SKILL_DESCRIPTION_MAX_CHARS`（1024，shared/constants）。
5. **Wiki file 来源**（`packages/core/src/wiki/ingest.ts:230-258`）：workspace 内文件复制进 `raw/`（append-only、哈希去重）→ 维护 loop 整合。Bot 用 mineru 导出 md 到 workspace 后 `wiki_enqueue(file)` 即闭环，无需改 core。
6. **上游锁定点**：`skills/mineru/SKILL.md` 最后一次变更 `bea1f6fac0a44abc2ca22b55bf180ca22b7c2666`（2026-09-23）；仓库 AGPL-3.0、默认分支 master、57.3k stars。
7. **prettier 全局忽略 `*.md`**（.prettierignore），vendored 原文不会被格式化工具改写。

## 3. 与设计文档的对照

| 设计约定 | 关系 |
|---|---|
| 05-wiki-and-skills「技能来源与作用域」：公共 = 市场预置、一次安装全体可用 | **扩展**：新增 vendored 子类（逐字引入的上游官方技能），来源/许可/锚点记录在 NOTICE.md |
| 05「依赖与环境」：缺少的宿主层环境经环境管理器申请安装，需用户确认 | **一致**：mineru CLI 由官方 Skill 文本指导 Bot 经 `uv tool install` 自行申请安装（D13 逐次确认），不在 preset 目录放 requirements.txt（避免误导性的依赖徽章） |
| 13-permissions D13/D36/D38：环境安装逐次确认、project 外写入需授权 | **一致**：官方 Skill 内置的"安装/升级/下载/上云均先征求同意"与宿主审批模型同构，无需额外机制 |
| 11-storage / 05 Wiki raw 只增不改 | **一致**：原始 PDF 与导出 md 并存 raw/，内容进 pages/，定位符可作引用锚点 |

## 4. 方案设计

### 4.1 vendored 预置条目（主要交付）

- `apps/desktop/resources/preset-skills/mineru/SKILL.md`：官方原文**逐字拷贝**（curl 上游 commit `bea1f6f` 锁定字节，不手打转录）；不自加 frontmatter、不翻译。
- `catalog.json` 增条目：`id=mineru`（须与 SKILL.md name 一致）、`section=starter`、`icon=scan-text`、`vendored=true`（新字段）、version `1.0.0`；中文名「文档解析（MinerU）」、摘要、试用语由 catalog 承担。
- `presets.ts` 的 catalog schema 增加可选 `vendored: z.boolean()`（zod 默认剥离未知键，显式声明以自文档化）。
- `NOTICE.md` 改写：开头的"全部原创"限定为"除 vendored 条目外"；新增 vendored 小节记录上游 URL、commit 锚点、引入日期、AGPL-3.0、独立第三方作品声明、同步方法。
- `preset-skills/README.md` 增「vendored 技能」小节：不许手改正文、同步后必须递增 version。

### 4.2 同步脚本

`scripts/sync-mineru-skill.mjs`（Node 22 全局 fetch，与 scripts/ 现有 .mjs 同风格）：

- `node scripts/sync-mineru-skill.mjs [ref]`：从上游拉取（raw.githubusercontent 优先、gcore.jsdelivr 镜像回退）写入 mineru/SKILL.md；校验 frontmatter `name: mineru`；打印 sha256 与「递增 catalog version / 更新 NOTICE 锚点」提醒。
- `--check`：只比对本地与上游，不一致退出码 1（可挂 CI）。
- 不自动递增 version、不自动改 NOTICE——同步是人工决策（发版节奏），脚本只做机械搬运。

### 4.3 目录守护测试扩展

`preset-skills-catalog.test.ts`：

- catalog schema 增可选 `vendored`；
- description 断言改为：非 vendored ≤300，vendored ≤ `SKILL_DESCRIPTION_MAX_CHARS`（1024）；
- 新增 vendored 专项断言：`compatibility === 'compatible'`（比通用断言更严）、NOTICE 含上游来源/commit 锚点/AGPL-3.0 字样。

### 4.4 明确不做（本轮）

- **不改 core**：wiki 入库、技能安装、扫描、沙箱策略全部复用既有管线。
- **不加 requirements.txt**：mineru 经 uv tool 安装而非 pip 进项目环境；加了会让市场徽章永远显示"缺依赖"（`depAvailable` 查的是工具链清单）。
- **不做实机 spike**（沙箱内 `mineru server start` 常驻、uv/模型写路径授权、大文档长任务）——运行时验证项，登记在 §6，不阻塞代码交付。

## 5. 改动清单

- [x] `docs/design/17-mineru-document-parsing.md`（新建，含方案对比、整合流程、风险）
- [x] `docs/design/README.md`（索引行 17 + 决策记录 D57）
- [x] `docs/design/05-wiki-and-skills.md`（raw 来源与公共技能来源补 vendored 交叉引用）
- [x] `todo/mineru-document-parsing.md`（本文件）
- [x] `apps/desktop/resources/preset-skills/mineru/SKILL.md`（上游 bea1f6f 逐字拷贝）
- [x] `apps/desktop/resources/preset-skills/catalog.json`（mineru 条目 + vendored 字段）
- [x] `apps/desktop/resources/preset-skills/NOTICE.md`（vendored 记录小节）
- [x] `apps/desktop/resources/preset-skills/README.md`（vendored 说明 + 同步流程）
- [x] `scripts/sync-mineru-skill.mjs`（同步 + --check）
- [x] `packages/core/src/skills/presets.ts`（catalog schema 增可选 vendored）
- [x] `packages/core/test/unit/preset-skills-catalog.test.ts`（vendored 例外与专项断言）
- [x] `docs/dev/PROGRESS.md`（证据小节）
- [x] `docs/dev/phases/P08-skills.md`（市场小节补 vendored 说明）

## 6. 测试计划

1. **基线**：不重跑全量，引用 [docs/dev/05-testing.md](../docs/dev/05-testing.md#开发中如何跑测试) 与 PROGRESS 中已记录的最近一次全量结果；偶发时序用例只单跑该文件复核。
2. **目录守护**：`preset-skills-catalog` 全绿——catalog schema（含 vendored 字段）、mineru parse/scan 通过、name=id、description 例外生效、compatibility=compatible。
3. **同步脚本**：`--check` 对 freshly vendored 内容报"一致"（退出码 0）；frontmatter 校验生效（临时改坏 name 应报错）。
4. **服务层回归**：`skills-presets.test.ts` 既有用例不受 schema 新字段影响。
5. **交付口径**：迭代中跑定向测试（`node scripts/run-tests.mjs run packages/core/test/unit/skills-presets.test.ts` 等相关文件）；交付前全量 `pnpm test` 一次 + `pnpm -r build` + `pnpm typecheck`。

## 7. 已知风险与 spike 清单（运行时验证，登记不在本轮闭合）

1. **常驻服务保活**：`standard` 档依赖 `mineru server start`；沙箱逐命令 exec 的进程组管理可能杀掉 daemon。备选：宿主级托管 parse server（core-host 形态）或验证 flash/basic 档进程内路径。
2. **沙箱写路径**：`~/.local/share/uv`、`~/.mineru` 在 workspace 外，需授权放行；或后续在 env catalog 增加 mineru 工具链项（宿主预装，市场徽章直接可用）。
3. **长任务**：全量导出大文档耗时/超时权衡；对话读取场景用分页续读省上下文。
