# src/renderer/skills 工作指南

这里负责“我的技能”和“技能市场”的展示、匹配、安装和详情。用户看到的是产品化技能，不是原始目录列表。

## 核心规则

- “我的技能”和“技能市场”里同一个技能必须能通过稳定 id 对齐，不能只靠标题或摘要匹配。
- 本机技能详情和市场技能详情复用同一个详情弹窗。
- 详情默认展示中文标题、中文摘要、来源和动作；`SKILL.md` 正文保留“展开正文”入口，但不默认铺开。
- 用户可见标题、分类、摘要优先中文元数据；只有技术名、文件名、未知第三方 skill 才回退英文。
- 不允许用“来自 Hermes 的技能，添加后会安装到本机技能库...”这类套话冒充精选摘要。

## 身份和匹配

技能身份优先级：

1. 市场 id / published id / package id。
2. 本机已安装技能记录里的 market id。
3. 来源 + 原始 name。
4. 仅在没有其他信息时才用显示标题。

安装状态必须通过稳定 id 判断。市场卡片显示“使用”时，应使用已经安装的本机技能 id 调用 composer，而不是再次安装。

## 中文展示

- `skillDisplayName`、`skillDisplayCategory`、`skillSummaryZh` 是本机技能中文展示的统一入口。
- 官方技能要维护中文名、中文分类、中文摘要映射。
- 市场技能优先使用 `name_zh`、`summary_zh`、`category_zh`。
- 英文 slug 可以放到 meta 或正文入口里，不应该作为中文用户的首要标题，除非没有中文名。

## 市场和远端来源

- 未精选的 Hermes remote 技能默认隐藏。只有明确开启市场来源或经过精选的技能才进入普通用户市场。
- 列表接口不要返回大段正文；列表卡片只需要标题、摘要、分类、来源、安装状态和必要 id。
- 正文加载失败不能让详情弹窗消失。正文区显示可恢复状态，简介仍可读。
- 技能本身很小，但远端列表仍要缓存；刷新时保留已有卡片，避免空白闪烁。

## 详情弹窗模式

详情弹窗必须提供这些状态：

- 简介视图：标题、摘要、来源、meta、主动作。
- 正文视图：渲染 `SKILL.md`，链接加 `target="_blank"` 和 `rel="noreferrer"`。
- 正文切换：`展开正文` / `返回简介` 或等价控件。
- 关闭方式：关闭按钮、backdrop、Escape。

本机技能正文还没读取完成时，正文入口仍要保留。点进去可以显示“正在读取完整正文...”，读取完成后刷新同一个弹窗。

## 安装和使用

- 市场安装走统一 install path，不在 renderer 拼包或写文件。
- 本机技能“使用”只负责把 skill attach 到当前 Bot 对话；没有当前 Bot 时显示中文提示。
- 删除本机技能后，如果当前详情弹窗指向该技能，必须关闭或刷新弹窗。
- 安装计数、下载信息和校验由 main/cloud 负责，renderer 不自行推断。

## 验证命令

```bash
node -c src/renderer/skills/skill-library.js
node -c src/renderer/skills/skill-helpers.js
node --test tests/skill-market-modal.test.js tests/skill-market-ui.test.js tests/skill-library-layout.test.js
node --test tests/cloud-skills-api.test.js
npm run check
```

改市场来源、Hermes 开关或安装流程时，必须同时跑 cloud skills 测试。
