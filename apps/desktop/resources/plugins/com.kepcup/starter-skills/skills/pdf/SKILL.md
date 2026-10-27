---
name: pdf
description: PDF 处理与生成。提取文字/表格、合并拆分、加密解密、生成 PDF（从文本/HTML/图片），PDF 转图片或文本。用户提到 PDF、"提取这一页"、"合并成一个 PDF"、"转成 PDF"、"填一下这个表" 时使用。
---

# PDF 处理

读取与页级操作（合并/拆分/加密/表单）用 `pypdf`，文字与表格提取用 `pdfplumber`，从零生成用 `reportlab` 或先写 HTML 再转。

## 环境准备

```bash
uv venv .venv && uv pip install pypdf pdfplumber
# 生成场景另加：uv pip install reportlab
# 或用 python3 -m venv 等价命令
```

## 提取（读 PDF）

```python
import pdfplumber

with pdfplumber.open('输入.pdf') as pdf:
    print(len(pdf.pages))
    text = pdf.pages[0].extract_text()            # 文字
    tables = pdf.pages[0].extract_tables()        # 表格 → 二维列表
```

- 扫描件（图片型 PDF）提取不到文字：先判断 `extract_text()` 是否为空，是则告知用户需要 OCR，不要硬编造内容。
- 跨页表格：逐页 `extract_tables()` 后拼接，注意表头只在首页出现的情况。

## 合并 / 拆分 / 页操作

```python
from pypdf import PdfReader, PdfWriter

writer = PdfWriter()
for f in ['a.pdf', 'b.pdf']:
    for page in PdfReader(f).pages:
        writer.add_page(page)
with open('合并.pdf', 'wb') as fh:
    writer.write(fh)

# 拆分：writer = PdfWriter(); [writer.add_page(p) for p in reader.pages[2:5]]
# 加密：writer.encrypt('密码')；解除密码：PdfReader(path, password='密码')
```

## 生成 PDF

- 内容型文档（报告/说明）：推荐先产出 HTML（排版可控、中文友好），再调本机 LibreOffice 或 Chromium headless 打印为 PDF；不可用时用 `reportlab`。
- reportlab 中文字体必须注册 TTF（如系统内的苹方/宋体），否则中文全是乱码：

```python
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

pdfmetrics.registerFont(TTFont('CN', '/System/Library/Fonts/STHeiti Light.ttc'))
c = canvas.Canvas('输出.pdf', pagesize=A4)
c.setFont('CN', 12)
c.drawString(72, 800, '中文内容')
c.save()
```

- 表单填写（AcroForm）：`pypdf` 读 `reader.get_fields()`，逐字段 `writer.update_page_form_field_values(page, {...})`；平铺（flatten）后再交付。

## 红线

- 转图片：`pdftoppm`（poppler）或 `pdfplumber` 页面对象 `.to_image()`；告知用户输出分辨率。
- 不修改用户原文件；加密 PDF 提供密码后才处理，不尝试绕过。
- 完成后报告：页数、输出路径、提取/生成的内容摘要；扫描件、缺字体等限制如实说明。
