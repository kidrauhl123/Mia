# 技能市场精选化 + 本地中文化 设计

日期：2026-06-10

## 背景与问题

技能市场当前从云端 `/api/skills` 合并 Hermes 聚合源（`src/cloud/hermes-skills-source.js`，覆盖 GitHub / skills.sh / browse.sh / ClawHub / LobeHub / Anthropic 等），聚合出几千条技能。问题：

1. **太多太乱**——海量技能无人工筛选。
2. **没有真正的中文介绍**——`skillSummaryZh`（7 条手写 + 关键词正则兜底套话）和 `marketDescriptionZh`（无中文时套一句模板）都是前端硬编码，聚合技能基本只有套话。
3. **点击卡片没反应**——市场卡只给「添加」按钮接了事件，卡片本身没有点击处理。

## 目标

精选一批高价值、现成的技能（不自造），写好中文摘要，随安装包本地交付，替代聚合消防栓；并给市场卡片加点击弹窗详情。

## 关键决策（已与用户确认）

1. **只留精选**：市场列表不再合并 Hermes 聚合。`hermes-skills-source.js` 代码保留但从「市场展示路径」摘掉（留作日后"探索全部"可选开关）。
2. **全本地交付**：精选目录随 app 发版打进 `resources/`，市场读本地 `skills/`，离线可用、零云端依赖、不要求登录。
3. **中文集中清单**：`skills/catalog.zh.json` 一处维护所有中文名/摘要/分类/排序；构建时校验目录↔清单一致。
4. **安装 = 本地拷贝**：点「添加」从本地 `skills/<id>/` 打包成 zip buffer 喂给现有 `installMarketplaceSkill`（复用其 zip-slip 守卫落盘到 `~/skills/<id>`）。
5. **卡片弹窗**：点卡片弹 modal，展示中文名 + 中文摘要 + 来源/分类 + 「添加」按钮；正文不铺开，做成「展开正文 ⇄ 返回」小按钮切换（复用 `renderSkillMarkdownSource`）。

## 精选清单（22 个，均为现成上游真实技能）

| id | 中文名 | 中文分类 | 上游来源 |
|---|---|---|---|
| pdf | PDF 文档处理 | 文档处理 | anthropics/skills |
| docx | Word 文档 | 文档处理 | anthropics/skills |
| xlsx | Excel 表格 | 文档处理 | anthropics/skills |
| pptx | PPT 幻灯片 | 文档处理 | anthropics/skills |
| web-artifacts-builder | 网页交互件构建 | 开发工程 | anthropics/skills |
| mcp-builder | MCP 服务搭建 | 开发工程 | anthropics/skills |
| webapp-testing | Web 应用测试 | 开发工程 | anthropics/skills |
| skill-creator | 技能创作 | 开发工程 | anthropics/skills |
| frontend-design | 前端界面设计 | 开发工程 | anthropics/skills |
| deep-research | 深度研究 | 研究资料 | claude-office-skills/skills |
| data-analysis | 数据分析 | 研究资料 | claude-office-skills/skills |
| literature-review | 文献综述 | 研究资料 | K-Dense-AI/claude-scientific-skills |
| paper-notes | 论文阅读笔记 | 研究资料 | Galaxy-Dawn/claude-scholar (daily-paper-generator) |
| meeting-notes | 会议纪要 | 写作效率 | claude-office-skills/skills |
| translation | 翻译润色 | 写作效率 | feiskyer/claude-code-settings |
| email-drafting | 邮件起草 | 写作效率 | claude-office-skills (email-drafter) |
| resume-polish | 简历优化 | 写作效率 | claude-office-skills (resume-tailor) |
| academic-writing | 学术写作 | 写作效率 | andrehuang/academic-writing-agents |
| latex-document | LaTeX 排版 | 学习 | ndpvt-web/latex-document-skill |
| flashcards | Anki 记忆卡 | 学习 | jalliet/flashcards |
| revision-notes | 复习笔记 | 学习 | maaarcooo/claude-skills |

实际落地 **21 个**。已去掉：commit-craft / weekly-report / trip-planner（占位低质）、canvas-design / brand-guidelines（图片生成类暂不要）。meal-planner 无干净现成源，跳过。

## 架构

```
skills/<id>/SKILL.md (+支撑文件)     ← vendored 真实技能，git 版本化，随包发
skills/catalog.zh.json              ← 中文清单：id → {name_zh, summary_zh, category_zh, source_label, order}
        │
src/main/skills/skill-market-local.js
  · loadLocalSkillMarket({catalogDir}) → 合并 SKILL.md frontmatter + catalog.zh.json → 市场列表
  · validateCatalog() → 目录与清单一致性（缺一即报错）
        │
main.js: IpcChannel.SkillsMarketList → 改读本地（替代 cloudDesktopSync().listMarketSkills）
main.js: IpcChannel.SkillsMarketInstall → 本地打包 zip → installMarketplaceSkill
        │
renderer skill-library.js «技能市场»
  · 去掉 cloudSignedIn() 登录门槛
  · 卡片接点击 → 弹窗 modal（中文摘要 + 展开正文/返回小按钮 + 添加）
        │
build-cloud-release.js / electron 打包：把 skills/ 拷进 resources/
```

## 中文清单 schema（catalog.zh.json）

```json
{
  "version": 1,
  "skills": [
    {
      "id": "pdf",
      "name_zh": "PDF 文档处理",
      "summary_zh": "读取、填写、合并拆分 PDF……",
      "category_zh": "文档处理",
      "source_label": "Anthropic 官方",
      "order": 1
    }
  ]
}
```

## 本地市场读取（skill-market-local.js）

- `loadLocalSkillMarket({catalogDir})`：读 `skills/` 下每个非 `_` 前缀目录的 `SKILL.md`（复用 `skills-catalog.js` 的 frontmatter 解析），与 `catalog.zh.json` 按 id 合并，输出 `[{id, name, name_zh, summary_zh, category, category_zh, sourceLabel, body, order}]`，按 `order` 再 `id` 排序。
- `validateCatalog({catalogDir})`：① `skills/` 里每个技能目录都在清单内；② 清单里每个 id 都有对应目录且有 SKILL.md；③ 必填字段（name_zh/summary_zh/category_zh）非空。任一不满足抛错，构建时跑。
- 纯函数、可独立测试，不依赖云端/Electron。

## 错误处理

- 缺 SKILL.md 的目录：跳过并在校验中报错（构建期暴露，不静默）。
- 清单缺字段：校验报错。
- 运行期读取失败：市场显示空态，不崩。

## 测试

- `tests/skill-market-local.test.js`：合并产出列表、排序、`_` 前缀排除、缺失字段降级。
- `tests/skill-catalog-zh.test.js`：清单↔目录一致性校验（正反向）、必填字段完整。
- 现有 `skill-market-ui` / `skills-loader-install` 随集成层调整。

## 实施顺序（受协调约束）

另有 AI 正大面积改集成点文件（skill-library.js / preload.js / ipc-channels.js / main.js / build-cloud-release.js / skills-loader.js，136 个未提交改动）。故：

- **第一波（零冲突，全新文件）**：vendor `skills/` 内容 + `catalog.zh.json` + `skill-market-local.js` + 两个测试。
- **第二波（集成层，待其文件落地/确认停手）**：main.js IPC 改本地、renderer 弹窗 modal + 去登录门槛、本地安装打包、build 打包 skills/。

## 范围外（YAGNI）

- 不删 Hermes 聚合代码，仅从市场路径摘掉。
- 不做"探索全部聚合"二级入口（留接口，本期不实现）。
- 不做技能评分/评论。
