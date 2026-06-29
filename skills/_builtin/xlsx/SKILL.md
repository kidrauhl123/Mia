---
name: xlsx
description: Excel deliverable gate for creating, editing, cleaning, and exporting spreadsheet files in Mia conversations.
category: 办公
source: Mia 官方
---

# XLSX Delivery Gate

Use this skill whenever the user asks for an Excel, XLSX, XLSM, CSV, TSV, or
spreadsheet deliverable. The final result must be a real file, not only a
Markdown table or an explanation.

## Required Workflow

1. Inspect the input and decide whether this is a new workbook, a cleanup task,
   or an edit to an existing template. When editing a user-provided workbook,
   preserve its sheets, formatting, formulas, naming conventions, and layout
   unless the user explicitly asks to change them.
2. Build or edit the spreadsheet with a real file-writing tool. Prefer:
   - `openpyxl` for `.xlsx` files with formatting, formulas, widths, sheets, and
     cell styles.
   - `pandas` for data cleaning or simple table export, then `openpyxl` when
     formatting is needed.
   - CSV/TSV only when the user explicitly asks for those formats.
3. Use Excel formulas for calculated cells instead of hardcoding Python-computed
   totals, percentages, margins, growth rates, ratios, or summaries. Keep source
   data and assumptions editable so the workbook can recalculate when inputs
   change.
4. Save the deliverable under the current Mia agent workspace, using a clear
   filename such as `world-cup-schedule.xlsx`.
5. Verify the file before answering:
   - The file exists.
   - The file size is greater than zero.
   - For `.xlsx`, reopen it with `openpyxl.load_workbook(...)`.
   - Check workbook formulas for obvious broken references such as `#REF!`,
     `#DIV/0!`, `#VALUE!`, `#N/A`, and `#NAME?`. If LibreOffice is available,
     recalculate the workbook before the final check.
6. If verification fails, fix the code or path and retry. Do not end with a
   permission explanation while the environment can write files.
7. In the final answer, say the file is attached or generated only after the
   verification step has passed. Include the filename or workspace path.

## Workbook Quality Rules

- Keep one raw/source-data sheet when cleaning or summarizing imported data, and
  write cleaned data, summaries, pivots, or charts to separate sheets.
- Put assumptions such as rates, thresholds, multipliers, and units in visible
  cells and reference those cells from formulas.
- Use stable number formats: dates as dates, percentages as percentages,
  currency with units in headers, and zeros/blank values consistently.
- Format headers, widths, frozen panes, filters, and important totals so the
  workbook is readable when opened directly in Excel or Numbers.
- For dashboards or reports, include a short notes/source sheet when values come
  from user-provided text, external data, or assumptions.
- Never silently overwrite an original input workbook. Write a new output file
  unless the user explicitly asks for in-place edits.

## Minimal XLSX Pattern

```python
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, Alignment, PatternFill

output = "world-cup-schedule.xlsx"
wb = Workbook()
ws = wb.active
ws.title = "Sheet1"
ws.append(["Column A", "Column B"])
ws.append(["Example", 1])
ws.append(["Total", "=SUM(B2:B2)"])

for cell in ws[1]:
    cell.font = Font(bold=True, color="FFFFFF")
    cell.fill = PatternFill("solid", fgColor="1F4E78")
    cell.alignment = Alignment(horizontal="center")

wb.save(output)

# Delivery Gate: prove the workbook is readable before responding.
loaded = load_workbook(output)
assert loaded.sheetnames
assert loaded.active.max_row >= 1
for sheet in loaded.worksheets:
    for row in sheet.iter_rows():
        for cell in row:
            value = str(cell.value or "")
            assert "#REF!" not in value
            assert "#DIV/0!" not in value
            assert "#VALUE!" not in value
            assert "#N/A" not in value
            assert "#NAME?" not in value
```

## Failure Rule

If file generation fails, keep working until the real blocker is resolved or a
tool/system error makes progress impossible. The useful outcome is a verified
file; a polished failure explanation is not a substitute for the file.
