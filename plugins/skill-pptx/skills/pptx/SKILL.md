---
name: pptx
description: PPT 演示文稿（.pptx）创建与编辑。做周会/汇报/路演幻灯片，从大纲或长文档生成演示，改版式、换模板配色、提取现有 PPT 的文字结构。用户提到 PPT、pptx、幻灯片、演示、"做个汇报"、"这页重做" 时使用。
---

# PPT 演示文稿（.pptx）处理

用 Python 的 `python-pptx` 生成与编辑 .pptx：产出原生可编辑文件，用户拿到后能继续改。

## 环境准备

```bash
uv venv .venv && uv pip install python-pptx
# 或：python3 -m venv .venv && .venv/bin/pip install python-pptx
```

## 先定大纲，再生成

1. 从用户材料提炼演示大纲：每页一个论点，标题即结论（"Q3 增长 32%" 优于 "Q3 数据"）。页数参考：周会 5-8 页、汇报 10-15 页。
2. 大纲经用户确认后再写代码生成，避免整份返工。
3. 生成脚本骨架：

```python
from pptx import Presentation
from pptx.util import Cm, Pt

prs = Presentation()
prs.slide_width = Cm(33.87)   # 16:9
prs.slide_height = Cm(19.05)

layout = prs.slide_layouts[1]          # 标题+内容版式
slide = prs.slides.add_slide(layout)
slide.shapes.title.text = 'Q3 增长 32%'
body = slide.placeholders[1].text_frame
body.text = '要点一：……'
p = body.add_paragraph()
p.text = '要点二：……'
p.font.size = Pt(18)

prs.save('输出.pptx')
```

## 实用要点

- 版式来自模板：`Presentation('公司模板.pptx')` 基于母版新建，自动继承配色与字体；用户没给模板时用默认版式并保持极简（白底、单色强调）。
- 每页要点不超过 5 条、每条不超过 2 行；超过的内容拆页或进备注（`slide.notes_slide.notes_text_frame.text`）。
- 图片：`slide.shapes.add_picture(path, left, top, width=...)` 按宽度等比缩放；两图并排先算好坐标再放。
- 表格：`shapes.add_table(rows, cols, left, top, width, height)`；数字右对齐，表头加粗。
- 编辑已有 PPT：先遍历 `prs.slides` 打印每页 shape 类型与文本，定位目标页再改；不要按页码盲改。

## 自检与交付

- 生成后用脚本重开断言页数、每页标题；条件允许时转图片抽查排版（本机有 LibreOffice 可 `soffice --headless --convert-to pdf` 再转图）。
- 报告：文件路径、页数、每页一句话摘要、遗留问题（缺图、待补数据）。
