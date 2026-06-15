# apps/mobile-rn 工作指南

这里是 Mia 的 Expo/React Native 移动端。移动端不能重新定义桌面和 Cloud 的协议，只能消费 shared/cloud contract。

## Expo 版本

Expo 行为经常变。改 Expo、EAS、推送、导航、权限、构建配置前，先读对应版本文档：

https://docs.expo.dev/versions/v56.0.0/

不要凭旧 Expo 经验改配置。

## 常用命令

在 `apps/mobile-rn/` 目录下运行：

```bash
npm test
npm run typecheck
npm run start
npm run android
npm run ios
```

EAS build、发布更新、推送证书、Firebase/FCM 配置都属于外部状态变更；用户没有明确要求时不要运行。

## 协议边界

- Cloud API URL、auth token、push token、conversation/message schema 必须跟桌面和 cloud contract 对齐。
- 不在移动端复制一套消息归一化协议；共享逻辑优先放到可测试模块。
- 服务器返回字段缺失时要有兼容默认值，但不要静默改写协议语义。
- 登录态失效要回到登录/绑定流程，不要无限重试接口。

## UI 和状态

- 用户可见文案默认中文。
- 移动端列表要处理离线、加载中、空状态和 token 失效状态。
- 动画不要影响 tab/rail 的静态可识别性；未选中态应稳定显示。
- React Query/cache 更新要避免把已有列表闪成空白。

## 测试

- 改消息解析、query、auth、push token 注册时，必须补或更新 Jest 测试。
- 涉及 TypeScript 类型的改动跑 `npm run typecheck`。
- 不把真实 Expo token、Firebase secret、生产用户 token 写进测试 fixture。
