# PI Remote 盲中继 · `pi-relay.v1`

中继把一个在线主机与若干移动端连接起来。仓库提供 Go、Node 24 和 Cloudflare Workers 三种 `pi-relay.v1` 实现。业务加解密、配对确认、持久设备授权及重放检测都在端点完成。中继不保存消息，也不保证离线投递。

## 快速运行

在仓库根目录运行 Node 版，无需 `npm install`：

```sh
node apps/relay/node/src/server.mjs
# 另开终端
curl http://127.0.0.1:8787/healthz
node --test apps/relay/node/test/*.test.mjs
```

在 `apps/relay/node` 也可以用 `npm start`、`npm test`。集成时，`createRelayServer(options)`（`node/src/relay-core.mjs`）直接返回 `http.Server`；使用 `server.listen(0, '127.0.0.1')` 分配临时端口，结束时 `await server.shutdown()` 同时关闭 HTTP 和升级后的连接。可选项：`maxFrameBytes`、`heartbeatMs`、`burst`、`framesPerSecond`、`requireTickets`、`pushWebhookUrl` 和 `pushAdapter: async event => …`。

Go 版（Go 1.22+，首次拉取已锁定的 WebSocket 模块需要联网）：

```sh
cd apps/relay/go
go test ./...
go build -trimpath -o relay ./cmd/relay
./relay
```

Windows 构建用 `go build -trimpath -o relay.exe ./cmd/relay`，运行 `./relay.exe`。Docker 从仓库根目录构建；最终 `scratch` 镜像只含静态 Linux 程序与 HTTPS CA 证书：

```sh
docker build -t pi-relay apps/relay/go
docker run --rm --read-only --cap-drop ALL -p 127.0.0.1:8787:8787 -e REQUIRE_TICKETS=1 pi-relay
```

| 环境变量 | 默认 | 用途 |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8787` | 监听地址。非容器本地调试建议绑定 `127.0.0.1`。 |
| `MAX_FRAME_BYTES` | `262144` | 完整 UTF-8 文本消息上限，含外层 JSON，不是字符数；最大配置 16 MiB。 |
| `REQUIRE_TICKETS` | 未设置 | `1` 表示从首次注册起，所有新客户端连接都需要票据。公网推荐启用。 |
| `PUSH_WEBHOOK_URL` | 未设置 | 配置可信 HTTPS 地址后 POST 固定唤醒事件；默认空接收器只确认请求，不会真的推送。 |

公网部署：通过反向代理终止 TLS，客户端只使用 `https://` 和 `wss://…/ws`。代理须透传 WebSocket Upgrade，空闲超时应高于两个心跳周期。禁用请求体、敏感头、WebSocket 帧及完整 URL 的日志/追踪。不要把凭据放入 URL。所有监听器、代理和推送服务都应限制并发及来源；尤其要在公网入口限制新连接/路由注册，或限制到受控内网。中继不信任 `X-Forwarded-For`，按 TCP 源 IP 计算配对限额；共享 NAT 或同一代理后的设备会共享配额。

## Go / Node 线路契约

`GET /healthz` 返回 `{"ok":true,"version":"1.0.0","protocol":"pi-relay.v1","stats":{"routes":0,"clients":0}}`；统计在线主机数及已绑定客户端数。`/ws` 接受文本消息，可在握手中协商 `pi-relay.v1`，也可省略子协议。一个 socket 只能注册一个角色、一个路由。

1. 主机生成随机 32 字节的 routeId（base64url）、独立的高熵 hostSecret 和 hostId；发送 `{t:"host.register",routeId,hostSecretHash,hostId}`。`hostSecretHash` 是 SHA-256(hostSecret UTF-8) 的十六进制。**这个哈希本身就能替换 WebSocket 主机，必须当成凭据保护**；不要放进二维码。成功返回 `{t:"host.registered",routeId,maxFrameBytes,heartbeatMs}`。routeId 为 16–128 个 `[A-Za-z0-9_-]` 字符，其他 ID 为同字符集的 1–128 个字符，推荐随机 UUID。
2. 客户端发送 `{t:"client.join",routeId,deviceId,joinToken?}`。主机离线一律返回 `ROUTE_NOT_FOUND`，不排队。成功返回 `client.joined`，通知主机 `peer.joined`；两条消息都含 `routeId, deviceId, hostOnline:true`。相同 deviceId 的旧连接在新连接通过校验后才被替换（4001）。主机的旧连接也仅允许相同哈希替换。
3. 配对阶段发 `{t:"pair",routeId,deviceId,payload}`，发送业务数据时发 `{t:"cipher",routeId,deviceId,frameId,envelope}`。两种消息都双向原样转发；额外或重复外层字段被拒绝，客户端冒用其他 deviceId 或 routeId 返回 `UNAUTHORIZED`。接收方应校验密文和配对证明。**不要在 `pair.payload` 中发送明文长期 deviceToken、inviteSecret、prompt 等**；中继只能原样转发，配对端点必须自行封装敏感字段。
4. 主机发送 `{t:"host.revoke",routeId,deviceId}`；目标收到 `{t:"error",code:"REVOKED",message:"Device revoked by host"}`，随即以 `4003 revoked` 关闭。撤销仅断开这次连接，**不是持久封禁 deviceId**；设备凭据失效必须由主机执行。未启用票据时，知道 routeId 的人可以尝试加入/替换该 deviceId，因此不能用设备名或 socket 绑定代替端到端鉴权。
5. 断开通知为 `peer.left`，含 `routeId, role`，若断开客户端则含 `deviceId`。主机断开时现有客户端可留在线上，但转发得到 `ROUTE_NOT_FOUND`。主机重新上线会向现存客户端发送 `peer.joined`（`role:"host",hostOnline:true`），向新主机重放已连接客户端的 `peer.joined`。不会缓冲或重放数据帧。
6. 应用心跳 `{t:"ping",ts}` → `{t:"pong",ts}`；另有 25 秒周期的 RFC 6455 ping/pong。进程停机用 `1001` 关闭。超限帧返回 `FRAME_TOO_LARGE` 并关闭 `1009`；超 16 KiB 的配对消息仅拒绝该消息（全局上限内）。普通错误为 `{t:"error",code,message}`。

默认连接限额为令牌桶：突发 120 条，每秒补充 60 条；配对按 IP 突发 10 条，每分钟补充 10 条。慢读端的出站队列有消息数与字节上限，宁可断连也不无限积压。连接及路由所有权记录各有 4096 上限。单进程内保留离线所有权，防止断线后用新哈希抢占；**重启清空所有内存状态**，包括所有权、票据与动态强制票据设置。重启后应由可信主机先注册，或换用新随机 routeId。不要把独立实例直接放入轮询负载均衡。

### HTTP 主机操作

两接口都要求在线路由与请求头 `X-Route-Id`、`X-Host-Secret`（原始 secret，**不是**哈希）。正文最多 4 KiB；不接受 URL 凭据。授权失败为 401，非法对象为 400，超大正文为 413，限流为 429。

| 端点 | 请求体 | 成功结果 |
|---|---|---|
| `POST /v1/tickets` | 空正文或 `{}` | `{joinToken,expiresAt}`，过期时间为 Unix 毫秒。随机 256 位票据在签发路由上 120 秒有效，原子单次消费。第一次签发后，该路由所有后续加入（含重连）一直需要新票据，不因票据耗尽而降级。 |
| `POST /v1/push/wake` | 仅 `{"deviceId":"…","wakeId":"…"}` | `{"ok":true}`。任何多余字段（包括 `title`、`body`、`prompt`、`routeId`）均被拒绝。每路由突发 10 次，每分钟补充 10 次。 |

适配器只收到 `{routeId,deviceId,wakeId,message:"PI-Desktop 有更新"}`。Webhook 超时 5 秒，不跟随重定向，不传主机凭据；上游失败返回 502，不回显上游正文。实际 APNs/FCM token 映射应由可信适配器管理。中继知道 IP、路由 ID、设备 ID、包大小和时间；“盲”仅指不持有会话密钥、不解密业务信封，不表示匿名或隐藏流量特征。

## Cloudflare Workers + SQLite Durable Objects

`apps/relay/cloudflare/src/worker.mjs` 是可部署的 Worker 入口。它通过 `RELAY_HUB` 绑定将 `/ws` 和 `/healthz` 转给同一个名为 `global-hub` 的 `PiRelayHub` 实例。`wrangler.jsonc` 将该类声明为 SQLite Durable Object。

`/ws` 接受 WebSocket 升级。主机注册和客户端加入后，`PiRelayHub` 原样转发 `pair` 与 `cipher` 文本帧。路由所有权哈希写入持久存储，连接角色及路由保存在 WebSocket 附件中，休眠唤醒后可继续转发。`GET /healthz` 仅返回 `ok`、`version` 和 `protocol`。Worker 不提供公共 Web 前端、HTTP 票据或推送接口，其他路径（包括 `/` 与 `/app.mjs`）均返回 404。

在仓库根目录运行 `npm run test:cf` 可用模拟连接与存储验证注册、转发、休眠恢复及撤销。
