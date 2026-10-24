# kepcup-server（headless 服务端）

KepCup 的自托管常驻形态（设计见 `docs/design/49-headless-server.md`，D102）：同一个 core（对话 / 调度 / 邮件 / MCP / 审批 / 记忆）跑在你的 NAS 或云服务器上，手机 PWA、任意设备的浏览器从任何位置直连同一个数据源——没有多端同步，没有"桌面必须醒着"。

- **无 UI、无 Docker**：只要 `node >= 22.19`。
- **账号密码登录（默认）**：首启建立管理员账号（终端交互输入，或 `--admin-user/--admin-password`），之后任何设备打开网址登录即用——不需要到服务端取配对码。会话 Cookie 30 天，改密码全端失效。
- **单端口三职责**：`/rpc` 登录会话 WS（birpc 直连）＋ `/` PWA 静态托管（打开网址即是完整客户端）＋ `/admin/*` 本机管理接口。
- **配对模式（可选）**：`--auth pairing` 退回 D96 设备配对（一次性码 + 端到端加密，`--relay` 中转模式恒为配对）；默认 auto-accept，`--pairing-manual` 人工确认。

## 安装

发布产物是单一自包含 tar.gz（原生模块已按平台预构建，目标机无需编译工具链），两种用法：

```bash
# npm 方式（优先）——全局命令 kepcup-server
npm i -g https://github.com/kepcup-app/kepcup/releases/download/v0.2.1/kepcup-server-v0.2.1-linux-x64.tar.gz

# tar 方式（补充）——解压即用
curl -LO https://github.com/kepcup-app/kepcup/releases/download/v0.2.1/kepcup-server-v0.2.1-linux-x64.tar.gz
tar -xzf kepcup-server-v0.2.1-linux-x64.tar.gz -C /opt/kepcup-server
/opt/kepcup-server/dist/cli.js --help
```

平台：`linux-x64` / `linux-arm64`（NAS 主场景）。其他平台走源码：`pnpm install && pnpm --filter @kepcup/server start`。

## 快速开始

```bash
# 局域网（IP 换成 NAS 的地址；服务端同源托管 PWA，任意设备打开 http://<ip>:8642）
kepcup-server --host 0.0.0.0 --public-url ws://192.168.1.10:8642

# 首次启动（交互终端）会提示设置管理员用户名与密码；
# 之后浏览器打开 http://<ip>:8642 → 登录页 → 输入账号密码即用
```

非交互（systemd）：`--admin-user admin --admin-password <你的强密码>`，或环境变量 `KEPCUP_SERVER_ADMIN_USER` / `KEPCUP_SERVER_ADMIN_PASSWORD`（仅首启建号时读取）。

常用子命令：

```bash
kepcup-server password            # 改管理员密码（校验旧密码；改完所有已登录会话失效）
kepcup-server version
# 配对模式（--auth pairing）下另有：
kepcup-server pair                # 出配对码（多设备）
kepcup-server devices            # 设备列表 / devices revoke <id> 撤销
```

常用选项（环境变量 `KEPCUP_SERVER_HOST/_PORT/_DATA_DIR/_PUBLIC_URL/_RELAY` 同名兜底）：

| 选项 | 说明 |
|---|---|
| `--data-dir <dir>` | 数据目录（默认 `~/.kepcup-server`；建议指到 NAS 的持久卷） |
| `--public-url <url>` | 客户端可访问的 `ws(s)://` 地址；`--host 0.0.0.0` 时必填；反代 TLS 场景填 `wss://<域名>` |
| `--keystore <kind>` | `system`（默认；Linux 需 Secret Service）或 `file`（NAS 常用，见下） |
| `--auth <mode>` | `password`（默认，账号密码登录）\| `pairing`（D96 配对码）；`--relay` 模式恒为 pairing |
| `--admin-user` / `--admin-password` | 非交互首启建号（环境变量 `KEPCUP_SERVER_ADMIN_*` 等价） |
| `--relay <url>` | 中转出站模式：不开入站端口，经公共/自建中转（`wss://remote.kepcup.com`）连客户端 |
| `--pairing-manual` | 配对请求不自动接受，由 `pair --accept <requestId>` 人工确认 |
| `--no-auto-pair` | 关闭首配自动出码 |

## 密钥（keystore）

- 默认尝试系统钥匙串；多数 NAS / 容器化 Linux 没有 Secret Service，会显式失败并提示。
- `--keystore file`：主密钥以 0600 明文存 `<data-dir>/master-key`。**拿到数据目录 = 拿到全部 secrets**（含各模型 API key）——请确保数据目录权限与磁盘加密符合你的威胁模型。
- admin token（本机管理接口的 Bearer token）同样以 0600 存 `<data-dir>/admin-token`，首启打印。

## systemd

```ini
# /etc/systemd/system/kepcup-server.service
[Unit]
Description=KepCup headless server
After=network-online.target

[Service]
User=kepcup
ExecStart=/opt/kepcup-server/dist/cli.js --host 0.0.0.0 --port 8642 \
  --data-dir /srv/kepcup --keystore file \
  --public-url wss://kepcup.example.com
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## TLS（公网部署建议）

服务端本身只说明文 HTTP/WS；公网请放反代终结 TLS（帧负载全程端到端加密，反代只见密文路由头；明文 `ws://` 仅建议可信内网）：

```caddyfile
# Caddy（自动证书）
kepcup.example.com {
  reverse_proxy 127.0.0.1:8642
}
```

nginx 用 `proxy_pass http://127.0.0.1:8642;`＋ `proxy_http_version 1.1`＋ `Upgrade`/`Connection` 头透传 WebSocket。Tailscale / WireGuard 内网可直接 `ws://<内网地址>:8642`。

## 与桌面应用的关系

- 桌面应用（Electron）行为零改动：headless 是新增宿主形态。
- 一个数据目录 = 一个用户的完整大脑。**桌面与服务端不互通、不同步**——选定哪个设备当大脑，其余设备都以客户端身份连它。
- 桌面作为客户端：浏览器打开服务端托管的 PWA 即是（与移动端同一份界面）。
- 本期不迁移桌面旧数据（设计决策：不做向后兼容）。

## 安全边界小结

| 面 | 机制 |
|---|---|
| 业务流量（password 模式） | 管理员账号（scrypt 哈希，0600）+ 登录限流（10 次/15 分钟/IP）+ HMAC 签名会话 Cookie（30 天，HttpOnly；改密码全端失效） |
| 业务流量（pairing 模式） | D96 配对设备 + 按设备 E2E（X25519+HKDF → AES-256-GCM + 防重放）+ token 重连 |
| 管理面（admin/CLI） | 仅环回 + Bearer token |
| 升级 WS | Origin 同源校验（防 CSWSH）、sid/role/版本校验、单帧 ≤512KB、连接数上限 |
| 审批 / 无人值守 | 与桌面同一套（远程客户端弹卡审批；`NEVER_AUTO_DECIDED` 等底线不变） |

## 开发

```bash
pnpm --filter @kepcup/server build      # tsc → dist/
pnpm --filter @kepcup/server test       # 定向：node scripts/run-tests.mjs run --project server
node scripts/pack-server.mjs            # 本地打包（release-server/*.tar.gz）
```

测试三件套：`test/direct-relay.test.ts`（直连监听层，真 ws 对打）、`test/config.test.ts`（CLI 解析）、`test/server-integration.test.ts`（临时目录全链路：配对 → hello → RPC → 重连 → admin）。
