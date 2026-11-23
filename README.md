# PI Remote Control

为 **PI-Desktop** 打造的端到端加密（E2EE）远程控制全套解决方案：**PI-Desktop 插件 + 移动端伴侣 App + 开源零知识盲中继后端**。

## 仓库结构

- `packages/protocol` — 零依赖、零 `eval`/`new Function` 的共享协议与密码学层（RFC 7748 X25519 + HKDF-SHA256 + AES-256-GCM、6 位 SAS 短码、防重放滑窗、游标续传、100ms 流式聚合、幂等去重、凭据路径黑名单）
- `apps/pi-plugin` — PI-Desktop 插件（`local.pi-remote-app`），0.1.5 版打包后的安装文件为 `apps/pi-plugin/dist/local.pi-remote-app-0.1.5.piplug`。
- `apps/relay` — 开源零知识盲中继后端（支持 `pi-relay.v1`）：
  - `apps/relay/go` — 生产级单文件 Go 实现 + `scratch` 非 root Dockerfile + 单元测试
  - `apps/relay/node` — 同协议零依赖 Node 24 即跑版（开发与联调开箱即用）
  - `apps/relay/cloudflare` — Cloudflare Workers + SQLite Durable Objects 盲中继，仅提供 `/ws` 与 `/healthz`。
- `apps/mobile-app` — React Native (Expo + TypeScript) 移动端工作台，支持流式对话、急停、Unified Diff 与审批。`web-preview/` 是用于本地开发的 Codex 单色 Web 预览，使用同一套 E2EE 协议。
- `tests/e2e-relay-plugin-client.test.mjs` — 三端全链路 E2EE 集成测试（Mobile ↔ Blind Relay ↔ PI-Desktop Plugin）
- `docs/ARCHITECTURE.md` — 架构设计与协议规范

## 快速开始

### 1. 运行 Node 自动化测试
```bash
npm test
```
依次运行共享协议、Node 中继、Cloudflare Worker（模拟 Durable Object 休眠恢复）、插件及移动端协议客户端经 Node 中继连接插件的端到端测试。Go 中继测试另见 `apps/relay/README.md`。

### 2. 安装 PI-Desktop 插件
1. 在 PI-Desktop 中打开 **Plugins（插件） → Install plugin package**。
2. 选择 `apps/pi-plugin/dist/local.pi-remote-app-0.1.5.piplug`。
3. 授权后在侧边栏打开「远程控制」视图，点击「生成配对码 (120s)」。

> **审批双模式说明**：
> - **默认标准模式**：发指令、切项目/会话、实时流式输出、看 Git Diff、一键急停全部直接生效；高危审批按宿主规则需回到桌面弹窗确认。
> - **完整无人值守模式（可选）**：以环境变量 `PI_DESKTOP_MCP_CONTROL=1` 启动 PI-Desktop 后，插件自动接入本机 `127.0.0.1` 回环控制面，手机端可直接批准工具权限 / AskTool / Plan。

### 3. 启动盲中继（公网穿透）与移动端预览
```bash
# 终端 1：启动本地 Node 盲中继（默认监听 8787）
npm run relay:dev

# 终端 2：启动本地 Codex 单色 Web 预览（默认 http://127.0.0.1:47930）
npm run app:web
```

### 4. 构建原生 iOS / Android App (Expo Development Build)
```bash
cd apps/mobile-app
npm install
npx expo run:android   # 或 npx expo run:ios
```
