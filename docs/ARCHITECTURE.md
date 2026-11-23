# PI Remote Control — 架构与协议规范 (v1)

## 1. 系统定位与三端分工

本项目为 **PI-Desktop** 提供端到端加密（E2EE）的远程控制套件，彻底替代 IM 聊天框的碎片化交互，面向编程 Agent 场景原生支持流式输出、工具调用折叠、Git Unified Diff 审阅、高危操作审批收件箱与一键急停。

```text
┌───────────────────────────┐     E2EE (X25519 + AES-256-GCM)     ┌─────────────────────────┐
│    PI-Desktop Plugin      │ ◀═════════════ LAN / Tailscale ═════▶│  Companion Mobile App   │
│  (apps/pi-plugin)         │                                      │  (apps/mobile-app)      │
│  - background.service     │   WSS Outbound         WSS Outbound  │  - Expo / React Native  │
│  - agentExtension bridge  │         ▼                    ▼       │  - 3-Screen Coding UX   │
│  - desktop.control + MCP  │    ┌────────────────────────────┐    │  - Unified Diff Viewer  │
└───────────────────────────┘    │  Zero-Knowledge Blind Relay│    │  - Safe Approval Inbox  │
                                 │  (apps/relay: Go + Node)   │    └─────────────────────────┘
                                 │  仅路由密文帧与通用唤醒推送  │
                                 └────────────────────────────┘
```

### 目录结构
- `packages/protocol`: 零外部依赖、零 `eval`/`new Function` 的共享协议层（消息 Schema、运行时校验、游标与幂等契约、E2EE 加密信封与配对指纹算法、跨端测试向量）。
- `apps/relay`: 开源零知识盲中继后端（`apps/relay/go` 生产级单文件 Go 实现 + `apps/relay/node` 同协议 Node 24 即跑版），支持路由注册、限时单次入房票据、有界帧队列、速率限制与零明文推送接口。
- `apps/pi-plugin`: PI-Desktop 插件（`id: local.pi-remote-app`，符合 `schemaVersion: 1` 与商店 `policyVersion: 2026.10.3` 审核红线），含后台服务、`desktop.control` + 可选 `PI_DESKTOP_MCP_CONTROL` 双适配器、`agentExtension` 流式事件采集桥、Git 只读 Diff（带根路径与凭据黑名单防护）、DPAPI/AES 加密凭据库与二维码配对面板。
- `apps/mobile-app`: React Native (Expo + TypeScript) 移动端 App，三页极简架构（主机与待处理收件箱 → 工作区与会话 → 流式对话/Diff/审批/急停工作台），支持真机 Expo Dev Build 与 Web 实时预览调试。

---

## 2. PI-Desktop v0.23.0 实证约束与双模式适配

| 能力 | 默认模式 (`desktop.control`) | 完整无人值守模式 (`PI_DESKTOP_MCP_CONTROL=1`) |
|---|---|---|
| 项目/会话列表、创建、打开 | ✅ 直接支持 | ✅ 直接支持 |
| 发送 Prompt、中止 (`agent/abort`) | ✅ 直接支持 | ✅ 直接支持 |
| 实时流式吐字 / 工具过程 | ✅ 通过 `agentExtensions` → 本地回环桥推送 | ✅ 同左 |
| 查看待审批 / AskTool / Plan 队列 | ✅ `agent/pendingInteractive` + `plans/pending` | ✅ 同左 |
| 查看 Git 状态与 Unified Diff | ✅ 插件受限只读 Git（含根包含校验 + 凭据黑名单） | ✅ 同左 |
| 远程批准工具 / 回答 AskTool / 批准 Plan / 切模型 | ⚠️ 宿主强制桌面弹窗确认，App 诚实标注“需桌面确认” | ✅ 经本机 `127.0.0.1:37123/mcp` 无弹窗直接执行 |

---

## 3. 盲中继 Wire 协议 (`pi-relay.v1`)

中继服务器完全不接触明文业务数据，只处理外层路由帧（JSON 文本帧，单帧上限 256 KiB）：

### 3.1 端点
- `GET /healthz` → `{ "ok": true, "version": "1.0.0", "protocol": "pi-relay.v1" }`
- `WS /ws` → 双向 WebSocket 路由通道
- `POST /v1/tickets` → 主机凭 `hostAuthToken` 签发短期（120s）单次客户端加入票据（可选，用于公网防枚举）
- `POST /v1/push/wake` → 主机凭 `hostAuthToken` 触发通用零明文唤醒推送（只传 `{ routeId, deviceId, wakeId }`，载荷固定为“PI-Desktop 有更新”）

### 3.2 外层帧格式
1. **Host 注册路由** (`host -> relay`):
   `{ "t": "host.register", "routeId": "<base64url-32B>", "hostSecretHash": "<sha256-hex>", "hostId": "<uuid>" }`
   - Relay 回复: `{ "t": "host.registered", "routeId": "...", "maxFrameBytes": 262144, "heartbeatMs": 25000 }`
2. **Client 加入路由** (`client -> relay`):
   `{ "t": "client.join", "routeId": "<base64url-32B>", "deviceId": "<uuid>", "joinToken": "<optional-or-hmac>" }`
   - Relay 校验路由在线（或允许有限等待），通知双方 `{ "t": "peer.joined", "deviceId": "...", "hostOnline": true }`。
3. **端到端密文转发** (`host <-> relay <-> client`):
   `{ "t": "cipher", "routeId": "...", "deviceId": "...", "frameId": "<uuid>", "envelope": { "v": 1, "alg": "X25519-HKDF-SHA256-AES256GCM", "kid": "...", "seq": 1, "iv": "<b64>", "ct": "<b64>", "tag": "<b64>" } }`
   - 中继**原样转发 `envelope`**，按 `deviceId` 定向投递，不解密、不落盘、不记录明文日志。
4. **保活与状态**:
   - `{ "t": "ping", "ts": 1730000000000 }` / `{ "t": "pong", "ts": 1730000000000 }`
   - `{ "t": "peer.left", "deviceId": "...", "role": "host|client" }`
   - `{ "t": "error", "code": "ROUTE_NOT_FOUND|UNAUTHORIZED|RATE_LIMITED|FRAME_TOO_LARGE|BAD_FRAME", "message": "..." }`

---

## 4. 内层 E2EE 业务协议 (`pi-remote.v1`)

### 4.1 配对流程（防二维码偷拍 + 零长期令牌明文）
1. 桌面端点击「生成配对二维码」，生成 120 秒单次配对邀请：
   `{ "v": 1, "hostId": "...", "hostName": "...", "hostSignPub": "<spki-b64>", "hostDhPub": "<raw-32b-b64>", "inviteId": "...", "inviteSecret": "<32b-b64>", "directUrls": ["ws://192.168.x.x:47921/ws"], "relayUrl": "wss://...", "routeId": "...", "expiresAt": 1730000120000 }`
2. 手机扫码后生成设备独立 X25519 密钥对，利用 `X25519(clientDhPriv, hostDhPub)` + `HKDF-SHA256(ikm, salt=inviteSecret, info="pi-remote-v1-pair")` 派生会话密钥与 **6 位核验短码 (`SAS`)**。
3. 手机发送 `pair.hello`（含 `deviceId`, `deviceName`, `clientDhPub`, `inviteProof = HMAC-SHA256(inviteSecret, hostId|deviceId|clientDhPub)`）。
4. 桌面面板弹出 6 位核验短码，用户核对一致并勾选允许的项目范围后点击「同意配对」；桌面原子消费邀请，持久化绑定 `deviceId -> sharedKey/devicePub`，回发 `pair.approved`（含 `deviceToken` 与权限集）。
5. 后续所有帧全部使用 AES-256-GCM 加密，**随机 96-bit IV + 关联数据 AAD = `v|hostId|deviceId|direction|seq`**（严禁拿事件游标充当加密 nonce），并维护滑动防重放窗口。

### 4.2 业务 RPC & 流式事件（解密后的内层 JSON）
- 请求帧：`{ "type": "req", "id": "<rpc-id>", "idempotencyKey": "<uuid>", "method": "...", "params": { ... } }`
- 响应帧：`{ "type": "res", "id": "<rpc-id>", "ok": true, "result": { ... } }` 或 `{ "type": "res", "id": "<rpc-id>", "ok": false, "error": { "code": "...", "message": "..." } }`
- 事件帧：`{ "type": "evt", "epoch": "<host-boot-id>", "seq": 42, "transient": false, "event": "...", "payload": { ... } }`

#### 核心方法目录
| 方法 | 作用 | 幂等性 |
|---|---|---|
| `host.info` | 返回主机信息、能力模式 (`standard` / `mcp-full`)、授权项目列表 | 只读 |
| `project.list` | 列出已授权项目 | 只读 |
| `session.list` | 列出项目下会话及运行状态 | 只读 |
| `session.get` | 获取会话历史消息 + 活跃游标快照 | 只读 |
| `session.create` | 创建新会话 | `idempotencyKey` |
| `session.open` | 切换桌面当前会话 | 幂等 |
| `turn.start` | 发送 Prompt（支持图片元数据引用） | `idempotencyKey` 去重 |
| `turn.abort` | 中止指定 `sessionId` / `turnId` | 绑定 `turnId` |
| `pending.list` | 汇总跨会话待审批工具 / AskTool / Plan 列表 | 只读 |
| `approval.resolve` | 审批工具权限（高危仅允许 `once`） | `approvalId` 原子单次 |
| `ask.resolve` | 提交 AskTool 选项或自定义回答 | `askId` 原子单次 |
| `plan.resolve` | 批准/拒绝 Plan 方案 | `proposalId` 原子单次 |
| `diff.summary` | 获取工作区 Git 变更文件列表（过滤凭据路径） | 只读 |
| `diff.file` | 获取单文件结构化 Unified Diff Hunks | 只读 |
| `sync.pull` | 依据 `(epoch, afterSeq)` 补拉缺失事件或触发快照重置 | 只读 |

#### 核心事件类型
- `stream.delta` (`transient: true`): 100ms 合并后的助手流式文本 / Thinking 增量
- `tool.update` (`transient: true`): 工具调用开始、增量输出、结束摘要
- `message.final` (`seq` 可回放): 定稿消息，替换临时增量
- `turn.state` (`seq` 可回放): `running` / `idle` / `aborted` / `error`
- `pending.updated` (`seq` 可回放): 待审批工具 / AskTool / Plan 队列变动
- `host.revoked`: 设备已被桌面端吊销，立即断连并清空本地凭证
