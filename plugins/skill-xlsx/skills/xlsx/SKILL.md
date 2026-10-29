---
name: xlsx
description: Excel 表格（.xlsx/.xlsm/.csv）读写、汇总、透视、图表与格式转换。做数据报表、财务简表、多表合并、CSV/JSON 与 Excel 互转、数据清洗。用户提到 Excel、表格、xlsx、csv、"做个表"、"汇总一下"、"数据透视" 时使用。
---

# Excel 表格（.xlsx）处理

用 Python 的 `openpyxl` 处理 .xlsx/.xlsm；CSV/TXT 用标准库 `csv` 即可，不必转成 Excel 再读。

## 环境准备

```bash
uv venv .venv && uv pip install openpyxl
# 或：python3 -m venv .venv && .venv/bin/pip install openpyxl
```

## 先摸清数据再动手

对已有文件，第一步永远是结构侦查，不要直接改：

```python
from openpyxl import load_workbook
wb = load_workbook('数据.xlsx', data_only=True)   # data_only: 读公式缓存值
for ws in wb.worksheets:
    print(ws.title, ws.dimensions, ws.max_row, ws.max_column)
    for row in ws.iter_rows(min_row=1, max_row=3, values_only=True):
        print(row)
```

- 注意 `data_only=True` 读的是"上次由 Excel 计算的缓存值"；本程序写入的公式没有缓存值，需要计算结果时用公式重算或在脚本里自行计算。
- 合并单元格只保留左上角值：侦查时打印 `ws.merged_cells.ranges`。

## 写报表的标准流程

1. 和用户确认口径：汇总维度、统计周期、金额单位。口径不清是返工的主要原因。
2. 一个脚本生成成品，带表头样式与列宽：

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

wb = Workbook()
ws = wb.active
ws.title = '月度汇总'
ws.append(['月份', '销售额', '同比'])
for c in ws[1]:
    c.font = Font(bold=True, color='FFFFFF')
    c.fill = PatternFill('solid', fgColor='4472C4')
ws.column_dimensions['A'].width = 12
ws.freeze_panes = 'A2'          # 冻结表头
ws.append(['2026-09', 1024.5, '+8.3%'])
ws['B5'] = '=SUM(B2:B4)'        # 需要原生公式时直接写公式字符串
wb.save('输出.xlsx')
```

3. 图表：`openpyxl.chart.BarChart()/LineChart()/PieChart()`，`ws.add_chart(chart, 'F2')`；图表是原生 Excel 图，用户可继续编辑。
4. 生成后自检：重新打开断言行列数与合计值，再报告。

## 常用转换

- CSV → xlsx：注意编码（`utf-8-sig` 兼容 Excel 打开中文 CSV）与列类型（日期/金额转成对应类型，不要全存文本）。
- xlsx → CSV：多 sheet 时逐个导出为 `表名.csv`，不要混在一起。
- 大文件（>10 万行）：`read_only=True` 流式读，`write_only=True` 流式写，避免内存爆掉。

## 红线

- 不修改用户原始文件：在副本上操作或另存新文件。
- 涉及金额：保留原始精度（用 Decimal 计算后再写入），四舍五入规则先问用户。
- 完成后报告：文件路径、sheet 结构、关键数字与口径假设。
