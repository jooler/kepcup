# 预置技能来源与许可说明（NOTICE）

除下节列明的 vendored 条目外，本目录下的全部技能内容（SKILL.md 与 requirements.txt）
均为 Kepcup 项目原创撰写，随应用分发给用户使用。

## vendored 上游技能

- **`mineru/`**：逐字引入 OpenDataLab **MinerU** 官方 Agent Skill（上游路径
  `skills/mineru/SKILL.md`，仓库 <https://github.com/opendatalab/MinerU>，
  锚点 commit `bea1f6fac0a44abc2ca22b55bf180ca22b7c2666`，引入日期 2026-10-04）。
  上游以 **AGPL-3.0** 许可发布，允许在保留许可与出处声明的前提下原样再分发；
  本目录**不改写、不翻译、不删节**其文本（改写会让每次同步变成人工比对）。
  该文件按独立第三方作品对待：Kepcup（GPL-3.0）不对其主张或变更许可，
  随应用分发与运行时复制进用户技能库的都是同一文件与同一许可。
- 跟随上游更新：`node scripts/sync-mineru-skill.mjs`（`--check` 只比对）；
  同步后**必须**递增 `catalog.json` 中该条目的 `version`，并更新本节的锚点
  commit 与引入日期。正文不得手改；发现问题应修上游或另立条目。

## 为什么不直接 vendor 其他上游技能

制作本目录时评估过 anthropics/skills 仓库（main @ `8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4`）：

- `docx` / `xlsx` / `pptx` / `pdf` 四个 document skills 为 **source-available**（其
  LICENSE.txt 明确禁止"在服务之外保留副本"与"向第三方分发"），**不可再分发**；
- `doc-coauthoring`、`internal-comms` 等工作流技能的仓库根目录**未附带许可文件**，
  授权状态不明确；
- 因此**没有复制上游任何文本**，其余八个技能全部原创（中文优先，贴合国内办公场景）。
  技能名（docx / meeting-notes 等）为通用的描述性名称。MinerU 的引入另见上节
  （AGPL-3.0 明确允许原样再分发，与 source-available 的不可再分发情形不同）。

## 上游技能引用的第三方库

技能指令中提到的 Python 库（python-docx、openpyxl、python-pptx、pypdf、pdfplumber、
reportlab）各自遵循其开源许可（均为 MIT/BSD 类），由用户环境在运行时安装，本目录
不包含其代码。

## 修改规则

- 修改技能内容 = 编辑对应目录的 SKILL.md，并在 `catalog.json` 中递增该条目的 `version`
  （内容寻址以目录内容的 sha256 为准，version 仅作展示）。
- 详见同目录 README.md。
