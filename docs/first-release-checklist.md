# Mia 第一版上线清单

> 历史产品验收记录，不是当前发布 runbook。
> 当前桌面打包、Cloud/Web 部署、生产验证和回滚命令统一以 [docs/DEPLOYMENT.md](DEPLOYMENT.md) 为准。
> AI 或发布 automation 不应再把这篇当操作入口。

这份清单来自 2026-06-10 讨论，用来判断第一版是否可以上线。状态只记录产品清单，不替代 `npm run check`、测试和生产部署 gate。

## 必须完成

1. OpenClaw 正式兼容
   - 状态：已取消；OpenClaw 支持从 Mia 主线移除。
   - 剩余：无。

2. 模型切换完整
   - 状态：Hermes、Claude Code、Codex 已走统一模型、effort、permission/runtime config 控制。
   - 剩余：桌面端视觉走查。

3. 设置界面按现状整理
   - 状态：模型、权限、账号、运行目标控制已拆分到独立模块；设备下拉已去掉冗长的 `.local Mia Desktop` 重复文案。
   - 剩余：上线前视觉/交互验收。

4. 修复 Bot 运行目标回退 bug
   - 状态：已覆盖 `cloud-claude-code` 与 `desktop-local` runtime binding，重启/同步不应把 Claude Code 运行目标回退成其它旧云端 runtime；两者都是 Bot 的运行位置，不是两套 Bot 身份。

5. 发现 AI 助手产品化
   - 状态：预设从 Mia 官方库读取；文案改为中文产品化描述；添加成功有“入库盖章”反馈。
   - 剩余：后续可接云端官方库，但第一版不依赖远端。

6. 技能市场上线可用
   - 状态：市场有缓存、安装、安全校验；首屏数量收窄；英文描述有中文兜底。
   - 剩余：继续精简官方推荐源和人工润色热门技能。

7. 多设备检查
   - 状态：脚本存在 macOS Apple Silicon、Intel、Windows 打包入口。
   - 阻塞：需要 Apple Silicon Mac、Intel Mac、Windows 真机分别安装、启动、运行 Agent、登录 Cloud Bridge。

8. 下载链接 CDN 加速
   - 状态：下载入口和更新入口已有固定 URL。
   - 阻塞：需要运维给 `mia.gifgif.cn/downloads/` 和 `/updates/` 配 CDN，并回源验证。

## 本机验证命令

```bash
npm run check
node --test tests/shared-contracts.test.js tests/chat-engine-registry.test.js tests/local-agent-engine-service.test.js tests/bot-commands.test.js tests/bot-directory.test.js tests/renderer-shell.test.js tests/skill-market-ui.test.js tests/skills-loader-install.test.js tests/cloud-skills-api.test.js tests/hermes-skills-source.test.js
```

## 真机验收矩阵

| 平台 | 必测项 |
| --- | --- |
| macOS Apple Silicon | 安装、启动、Claude Code/Codex/Hermes 检测、模型切换、Cloud Bridge 在线 |
| macOS Intel | 安装、启动、Agent 检测、模型切换、Cloud Bridge 在线 |
| Windows | 安装、启动、Agent 检测、Cloud 登录、基础聊天 |

## CDN 验收

- `https://mia.gifgif.cn/downloads/mia-macos-arm64-latest.dmg`
- `https://mia.gifgif.cn/downloads/mia-macos-intel-latest.dmg`
- `https://mia.gifgif.cn/updates/latest-mac.yml`

以上链接需返回 200，命中 CDN，并能下载完整文件。
