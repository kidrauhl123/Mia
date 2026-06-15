# src/cloud 工作指南

这里是 Cloud 数据和 API 层。`scripts/serve-cloud.js` 是入口，但新业务逻辑应优先放到 `src/cloud/` 的 store、service 或 contract 模块。

## 验证命令

```bash
node --test tests/cloud-*.test.js
node --test tests/cloud-skills-api.test.js
npm run check
npm run cloud
```

`npm run cloud` 只用于本地调试。部署、生产验证、release handoff 必须由用户明确要求。

## API 规则

- 所有需要账号的数据 API 必须校验 auth。
- 会话、群组、消息、设置、技能安装都要校验 owner/member 权限。
- 列表接口必须有分页或 limit 上限，不能一次返回无界数据。
- 列表响应不要带大正文或敏感字段；详情接口再返回重内容。
- 错误响应使用稳定 `{ ok: false, error, status? }` 或现有同领域格式，不要混入 HTML/纯文本。

## SQLite 和 Store

- schema 变更写成可重复运行 migration。
- migration 不能依赖当前线上“刚好没有旧数据”。
- 新字段要有默认值，旧行读取不能抛。
- 写测试时用 `fs.mkdtempSync(path.join(os.tmpdir(), ...))` 这类临时目录。
- 测试结束要关闭 server/db，删除临时目录由测试 fixture 负责。

## Cloud Settings 和事件

- Cloud settings 是跨设备状态，不要绕开既有 CAS/版本控制写路径。
- 桌面 daemon、窗口、web、mobile 不能各自变成 settings writer；先确认 canonical writer。
- 持久事件和瞬时事件要分开：需要历史回放的写 store，只用于当前在线提示的走 transient broadcast。
- SSE/WebSocket 客户端断线重连不能制造重复持久事件。

## 技能市场

- Hermes remote 技能默认不进普通市场；只有 `MIA_HERMES_SKILLS_MARKET=1` 或显式测试 source 时才启用。
- 官方/精选技能和用户发布技能要有稳定 id，避免互相抢占。
- 市场列表返回中文标题、摘要、分类时，优先读 curated/snapshot 元数据。
- 安装接口要做包校验、版本记录和安装计数去重。
- 未知技能安装返回 404，不要静默 fallback 到任意本地目录。

## 日志和安全

- 请求日志不要包含 token、cookie、authorization header、完整消息正文或 secret。
- 生产开关不要靠“未设置环境变量就启用”这种反向默认；危险或外部来源功能默认关闭。
- 需要外部网络的 fixture 要可注入 URL，测试不依赖真实第三方服务。
