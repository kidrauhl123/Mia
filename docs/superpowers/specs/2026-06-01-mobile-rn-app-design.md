# 原生手机端设计 · React Native + Expo

日期:2026-06-01
状态:已采用
取代:`2026-06-01-mobile-view-design.md`(Capacitor 路线)、`2026-06-01-mobile-ota-update-design.md`(Capacitor OTA)

## 背景与方向

体验对标 Telegram,要原生手感。手机端从 Capacitor(WebView)转为 **React Native + Expo** 原生 app。
**云端零改动** —— 既有 REST + WebSocket API、数据契约、协议(`clientOpId` 幂等、`mia-token.<token>`
subprotocol、`since_seq` 续传)全部照用;重写的只是客户端视图层。

旧 Capacitor/WebView 端已经退役。仓库里的手机端入口是 `apps/mobile-rn/`;共享协议与纯逻辑从
`packages/shared` 引入,不再通过 `src/mobile` 维持第二套实现。

## 决策摘要

| 维度 | 决定 |
| --- | --- |
| 框架 | React Native + **Expo managed** workflow |
| 语言 | **TypeScript** |
| 导航 | React Navigation:底部 Tab(消息/联系人/我)+ native-stack(列表→聊天) |
| 数据 | **TanStack Query**(REST 缓存/失效)+ 薄 WebSocket 客户端(实时事件) |
| 目录 | 新目录 `apps/mobile-rn/`,独立 `package.json`,与 Electron 依赖隔离 |
| 平台 | **Android 优先**;iOS 同一套代码以后顺手出(需 Mac + Apple 账号) |
| 首版范围 | 登录 + 底部 Tab + 聊天(气泡 + trace 折叠)+ 乐观发送 + WS 实时 + **权限底部 sheet** |
| 构建/发布 | **EAS Build**(云出 APK/IPA)+ **EAS Update**(expo-updates JS 层 OTA) |
| 推送 | `expo-notifications`(审批/消息/任务)—— **另开 spec**;首版前台 WS |
| Token 存储 | `expo-secure-store`(Keychain/Keystore),比 web 的 localStorage 更稳 |
| 默认服务器 | `https://aiweb.buytb01.com`(登录页可改) |

## 架构与文件布局

```
apps/mobile-rn/
  app.config.ts        Expo 配置:name/slug、android.package=app.mia.mobile、
                       updates(EAS Update URL + runtimeVersion policy)、插件
  eas.json             构建档:development(dev client)/ preview(apk,直装)/ production
  package.json         expo / react-native / @react-navigation/* / @tanstack/react-query /
                       @gorhom/bottom-sheet / react-native-markdown-display / expo-secure-store ...
  tsconfig.json
  App.tsx              根:QueryClientProvider + AuthProvider + RootNavigator
  src/
    api/
      types.ts         领域类型:Conversation / Message / Member / Fellow / Friend /
                       ApprovalEvent / WsEnvelope
      client.ts        REST:fetch 封装 + Bearer + clientOpId 幂等(@mia/shared/cloud-client 薄适配)
      events.ts        WebSocket:mia-token subprotocol + since_seq + 退避重连(同上薄适配)
    state/
      auth.tsx         token(secure-store)+ AuthContext + 登录/登出
      queries.ts       react-query hooks:useConversations / useMessages / useFellows /
                       useFriends / useSettings
      events.tsx       WS 连接生命周期 + 事件分发到 query cache / 审批队列
    logic/             纯函数,jest 单测;跨端规则从 @mia/shared 复用
      sendPipeline.ts        prepareOutgoingMessage(trim/校验/mentions/clientTraceId)
      conversationList.ts    buildConversationListItems
      approvalQueue.ts       createApprovalQueue(底部 sheet 队列状态机)
      optimisticSend.ts      buildPendingMessage / reconcilePending
    navigation/
      RootNavigator.tsx  auth gate → Tabs
      Tabs.tsx           消息 / 联系人 / 我
    screens/
      LoginScreen.tsx  ConversationListScreen.tsx  ChatScreen.tsx
      ContactsScreen.tsx  MeScreen.tsx
    components/
      MessageBubble.tsx  TraceBlock.tsx(可折叠)  ApprovalSheet.tsx(@gorhom/bottom-sheet)
      Avatar.tsx  ConnBanner.tsx
    theme.ts
  __tests__/           logic/* 单测
```

边界:`api/*` 是唯一碰网络的层;`logic/*` 纯函数无副作用(可单测);screens/components 只做渲染 +
调 hooks。WS 副作用(连接/重连/分发)收在 `state/events.tsx`。

## 复用映射

端无关规则必须来自 `packages/shared`;RN 本地文件只保留 UI 组合或薄 re-export:
- `@mia/shared/send-pipeline` 的 `prepareOutgoingMessage` → `logic/sendPipeline.ts`
- `@mia/shared/approval-queue` → `logic/approvalQueue.ts`
- `@mia/shared/optimistic-send` → `logic/optimisticSend.ts`
- `@mia/shared/cloud-client`(REST + WS)→ `api/client.ts` + `api/events.ts`
- `@mia/shared/avatar` / `contact` / `group-tiles` / `session-history` → 对应 `logic/*` 薄适配
- `logic/conversationList.ts` 仍是 RN 视图模型,但必须通过共享 session/avatar helper 解析身份
- `src/shared/agent-permissions.js` 的 decision/choice 常量与 `decisionToHermesChoice` → `api/types.ts` 内常量

> RN 不复用浏览器端 DOM 模块(trace-blocks / cloud-conversation-source / styles.css);
> 这些用 RN 组件重写。**纯逻辑与协议**复用,**视图**重写 —— 这正是原生路线的边界。

## 界面组件(RN)

- **LoginScreen**:服务器(默认生产)、用户名、密码;登录/注册;错误提示。
- **消息 Tab → ConversationListScreen**:`FlatList` 渲染会话(头像 + 名 + 末句 + 未读角标),点进 ChatScreen。
- **联系人 Tab**:好友 + 自有 fellow。
- **我 Tab**:账号、退出。
- **ChatScreen**:`FlatList`(inverted)消息气泡 + **TraceBlock**(默认收起,点开看 reasoning/工具)+
  输入框;有待审批时 **ApprovalSheet**(@gorhom/bottom-sheet,允许/拒绝/始终)。
- Markdown 正文用 `react-native-markdown-display`。

## 数据流

1. 启动:secure-store 有 token 直接进,否则 LoginScreen。
2. 登录拿 token → secure-store;react-query 拉 conversations / fellows / friends / settings。
3. `state/events.tsx` 开 WebSocket(`mia-token.<token>`)。事件:
   - `message` / `message.created` → 写入对应会话的 query cache(经 `reconcilePending` 按 clientTraceId 对账)。
   - `approval.request` / `approval.responded` → 驱动 approvalQueue → ApprovalSheet。
4. 发消息:`buildPendingMessage` 生成 pending 气泡乐观插入 → POST → ack 经 `reconcilePending` 落定;失败标红可重试(clientOpId 幂等)。
5. 切后台 WS 断,回前台用持久化 `since_seq` 续传补齐。

## 错误处理

- WS 断:退避重连,顶部 ConnBanner 显示"连接中"。
- 发送失败:气泡标红 + 重试;clientOpId 保证不重复。
- 审批失效(超时/run 结束):sheet 提示并关闭。
- 服务器不可达:登录页明确报错,可改地址重试。

## 构建 / 发布(EAS)

- `eas.json` 三档:`development`(dev client,本地调试)/ `preview`(出 **APK** 直装手机)/ `production`。
- 出测试包:`eas build -p android --profile preview` → 云端构建,完事给安装链接/二维码,手机直接装。
- **OTA 热更**:`eas update --branch preview` 推 JS 包;app 启动经 `expo-updates` 拉取生效 —— 这就是"app 内更新、免手动转发"的原生实现。改原生(加插件/权限)才需重新 `eas build`。
- 需要 Expo 免费账号登录一次(`eas login`,交互,由你来做)。
- 默认 API base 编译进配置,可登录页覆盖。

## 测试

- **纯逻辑 jest 单测**(`__tests__/`):sendPipeline 校验、conversationList 排序/降级、approvalQueue 队列流转、optimisticSend 对账;client 的 clientOpId 注入、events 的 URL/subprotocol/退避(mock fetch/WebSocket)。
- 组件冒烟(可选,`@testing-library/react-native`)。
- 真机手验:EAS preview APK 装机,跑三条主链路 —— 收发消息、展开 trace、底部 sheet 审批;再验一次 `eas update` 热更到手机。

## 明确不在本 spec

- 推送(expo-notifications)—— 另开 spec。
- iOS 出包 / 上架(同代码,后续)。
- 既有 web↔desktop 功能差距的补齐。
