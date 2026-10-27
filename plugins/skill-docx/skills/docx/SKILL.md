---
name: docx
description: Word 文档（.docx）创建、编辑与分析。写报告、方案、合同初稿、通知公文，改已有文档的段落/表格/样式，批注与修订处理，或 .docx 与 Markdown/TXT/PDF 之间的转换。用户提到 Word、doc、docx、文档初稿、"写个方案"、"改一下这份报告" 时使用。
---

# Word 文档（.docx）处理

用 Python 的 `python-docx` 库处理 .docx：它直接操作 OOXML 结构，保真度最高；不要让模型逐字"打印"文档内容。

## 环境准备

脚本在工作区运行。首次使用时先准备环境（已就绪则跳过）：

```bash
uv venv .venv && uv pip install python-docx
# 或：python3 -m venv .venv && .venv/bin/pip install python-docx
```

## 新建文档的标准流程

1. 明确文档结构再动手：标题层级、章节顺序、是否需要目录/页眉页脚。信息不足时先向用户确认大纲。
2. 用一个脚本完成整份文档，不要多轮碎片拼接：

```python
from docx import Document
from docx.shared import Pt, Cm
from docx.oxml.ns import qn

doc = Document()
# 中文字体：设置 East Asia 字体，否则中文回退到默认西文字体
style = doc.styles['Normal']
style.font.name = 'Calibri'
style.element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')
style.font.size = Pt(12)

doc.add_heading('项目方案', level=0)      # level 0 = Title
doc.add_heading('一、背景', level=1)
doc.add_paragraph('正文内容……')

table = doc.add_table(rows=3, cols=4)
table.style = 'Table Grid'
table.cell(0, 0).text = '项'
doc.add_picture('chart.png', width=Cm(14))

doc.save('输出文件名.docx')
```

3. 生成后用脚本自检：重新打开，断言段落数/标题数/表格行数符合预期，再向用户报告完成。

## 编辑已有文档

- 先读后改：用脚本遍历 `doc.paragraphs` / `doc.tables` 打印现有结构与文本，确认目标段落再修改。直接按索引盲改容易错位。
- 改样式优先改 `style`，其次局部 run 级覆盖；批量改字体/字号用样式而不是逐段设置。
- 表格增删行列：`table.add_row()`、`table.columns[0].cells`；合并用 `cell_a.merge(cell_b)`。
- 保留原文档：改前先把原文件复制为 `原名.backup.docx`（工作区内），再写新文件，避免覆盖用户原始材料。

## 批注与修订

- `python-docx` 对批注/修订支持有限：读取可用底层 XML（`w:comment`、`w:ins`/`w:del`）；复杂的修订接受/拒绝，建议先转 Markdown 给用户确认内容，再产出干净新版。
- 用户要求"按批注修改"时：先列出全部批注与对应正文，逐条给出处理意见，确认后再动文档。

## 格式转换

- docx → PDF：调用本机 LibreOffice（`soffice --headless --convert-to pdf`）；不可用时告知用户并给出替代（导出后由用户在 Word/WPS 里另存）。
- docx → Markdown：按段落样式映射标题层级，表格转 Markdown 表格；图片导出到 `assets/` 子目录并相对引用。
- .doc（旧格式）：先转换成 .docx 再处理。

## 输出约定

- 产出文件放当前工作区，文件名用业务语义（如 `2026Q4-营销方案-v2.docx`），不要 `output.docx`。
- 完成后报告：文件路径、章节结构摘要、自检结果；有未决问题（缺数据、待确认口径）一并列出。
