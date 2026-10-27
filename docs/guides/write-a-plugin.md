# 写一个 KepCup 插件

**适用范围**：你想把一组技能、连接器、MCP 服务器或邮件模板打包成一个 `.kepcup`，让别人在 KepCup 里安装。
**前提**：本机有 KepCup 的仓库（`kepcup-app` 在 `packages/app-validator`），Node.js ≥ 22.19。

插件是**声明式**的：宿主的进程里不会执行包内任何代码。需要本地执行的能力只能以**内嵌 MCPB**（`.mcpb`）提供；需要 OAuth 的远端服务做成**连接器贡献**；不需要认证的公网 MCP 可以用 **http 贡献**。
设计依据：[design/51-plugin-system.md](../design/51-plugin-system.md)。

## 1. 目录结构

```text
my-plugin/
├── plugin.json                 # 清单（必需，包根）
├── README.md                   # 详情页展示（建议）
├── icon.png | icon.svg         # 可选（≤ 256KB）
├── skills/
│   └── hello/
│       └── SKILL.md            # 标准 Agent Skill 目录
├── connectors/
│   └── acme/
│       ├── server.json         # 连接器条目（开放平台格式）
│       └── acme.svg            # 图标必须与 server.json 同目录
├── mcp/
│   └── echo.mcpb               # 内嵌 MCPB
└── examples/                   # 任意其他文件会原样进包
```

`plugin.json` 里的 `dir` / `file` 都是**相对 POSIX 路径**；不能用绝对路径、`..`、反斜杠、冒号。包内不允许符号链接。

## 2. `plugin.json`

```jsonc
{
  "format_version": 1,
  "id": "io.github.alice/doc-tools",     // 反向域名/名字；com.kepcup / local.kepcup 保留
  "name": "文档工具集",
  "version": "1.2.0",
  "description": "处理 Markdown / DOCX 的技能与 MCP 服务器",
  "author": { "name": "Alice", "url": "https://alice.example" },
  "homepage": "https://github.com/alice/doc-tools",
  "engines": { "kepcup": ">=0.4.0" },
  "platforms": ["darwin", "win32", "linux"],   // 缺省 = 全平台
  "contributions": {
    "skills":     [{ "dir": "skills/hello" }],
    "connectors": [{ "file": "connectors/acme/server.json" }],
    "mcp": [
      { "id": "echo", "kind": "mcpb", "file": "mcp/echo.mcpb", "name": "Echo", "description": "…" },
      { "id": "docs", "kind": "http", "url": "https://mcp.example.com/mcp", "description": "…" }
    ],
    "mail": [
      {
        "id": "fastmail",
        "label": "Fastmail",
        "imap": { "host": "imap.fastmail.com", "port": 993, "secure": "ssl" },
        "smtp": { "host": "smtp.fastmail.com", "port": 465, "secure": "ssl" },
        "defaultMode": "auto",
        "helpUrl": "https://www.fastmail.help/"
      }
    ]
  }
}
```

规则要点：

- `id` 同时是插件主键；同一 id 不能跨来源并存。`format_version` 目前只能是 `1`。
- 清单是 strict schema：`tier`、`permissions` 之类字段一律拒绝——分级与权限由来源和贡献内容推导，不采信清单自述。
- 至少要有**一类贡献**；每类数量上限：技能 50、连接器 20、MCP 10、邮件模板 10。
- 清单 ≤ 64KB；zip 上限 512MB / 解包 500MB / 条目 20,000 / 单文件 200MB；不支持 ZIP64 与加密。
- `engines.kepcup` 用 semver 范围；开发版 KepCup（`0.0.0`）会跳过这项检查。
- 技能展示字段（`displayName` / `summary` / `icon` / `section` / `tryIt` / `vendored`）只给内置插件用，第三方插件可省略，界面回落到 `SKILL.md` 的 `name` / `description`。

## 3. 四类贡献的最小例子

### 技能

`skills/hello/SKILL.md`：

```markdown
---
name: hello
description: 用一句话说明这个技能做什么、什么时候该用。
---

# Hello

写清楚步骤、注意事项和示例。KepCup 安装时会解析 frontmatter、扫描运行时依赖并做沙箱兼容检查。
```

### 连接器

`connectors/acme/server.json` 就是开放平台的 `server.json` + `_meta`：

```jsonc
{
  "name": "com.acme/mcp",
  "title": "Acme",
  "description": "Acme issue tracker",
  "version": "1.0.0",
  "remotes": [{ "type": "streamable-http", "url": "https://mcp.acme.example/mcp" }],
  "_meta": {
    "app.kepcup/connector": {
      "slug": "acme",
      "icon": "acme.svg",
      "category": "project",
      "tier": "community",                  // 插件来源会改写 tier，填 community 即可
      "auth": {
        "kind": "oauth",
        "registration": "auto",
        "clientRef": null,
        "scopes": { "default": [], "write": [] }
      },
      "toolPolicy": {},
      "skills": [],
      "ui": false,
      "privacyPolicy": "https://acme.example/privacy"
    }
  }
}
```

连接器端点必须是**公网 https**（不能是 IP、`localhost`、内网域名）；`packages[]` 必须为空——本地执行请改用 `mcp` 贡献。连接器装好后仍需用户逐项连接，工具走既有审批 / 风险 / 锁定语义。

### 内嵌 MCPB

`mcp/echo.mcpb` 是标准 MCPB 包（zip + `manifest.json` + `server.entry_point`）。插件内的 MCPB 由 KepCup 的 `McpbInstaller` 解包到 `toolchains/`，运行时（Node / Python / uv）由用户在「设置 → 环境」安装；`user_config` 的敏感值进 secrets。

### http MCP

```jsonc
{ "id": "docs", "kind": "http", "url": "https://mcp.example.com/mcp" }
```

必须公网 https、无认证（`auth: none`）。需要 OAuth 的远端请做成连接器贡献。

### 邮件模板

只预填「添加邮箱」表单，不落库；账号创建后是普通的 `custom` 邮箱，卸载插件不影响已建账号。主机必须是公网域名（不能是 IP / localhost / `.local` / `.internal` 等）。

## 4. 工作流

```sh
# 1. 生成骨架（--id 缺省 io.github.your-name/<目录名>）
node packages/app-validator/dist/cli.js init plugin ./my-plugin --id io.github.alice/doc-tools

# 2. 编辑 plugin.json 与各贡献
# 3. 本地自检（完全离线、不执行包内代码）
node packages/app-validator/dist/cli.js validate ./my-plugin

# 4. 边改边调试：扩展中心 → 已安装 → 从文件夹安装…
# 5. 打包（先跑同样的校验，有 error 不产出文件）
node packages/app-validator/dist/cli.js pack ./my-plugin --out ./my-plugin.kepcup

# 6. 验证产物（可再次 validate 或直接安装）
node packages/app-validator/dist/cli.js validate ./my-plugin.kepcup
```

`pack` 的输出是**可复现**的：条目排序、时间戳固定，同一目录两次打包 sha256 相同。默认排除 `.git/`、`node_modules/`、`.DS_Store`、`*.kepcup`、`.kepcup-ignore` 自身；`.kepcup-ignore` 每行一个相对路径或 `目录/`，`#` 注释，不支持通配符。

把 `kepcup-app` 加成 bin 后也可以直接 `kepcup-app validate ./my-plugin`。

## 5. 信任分级与同意卡

| 来源 | 分级 | 用户会看到什么 |
|---|---|---|
| 本地安装（文件 / 文件夹） | `developer` | 「未审核」警示；连接器工具逐次确认、无持续授权；MCP server 标 developer |
| 自托管市场 | 最高 `community` | 自托管索引的签名与用户登记的公钥决定信任 |
| 官方市场 | `verified` / `community` | 索引里的分级；权限扩大时更新要重新同意 |

安装前 core 会推导并展示：技能数量、连接器主机与 OAuth 范围、MCPB 的启动命令 / 运行时状态 / sha256 / 必填 `user_config`、邮件模板。**权限永不来自清单自述**。

## 6. 常见错误

| 检查项 | 常见原因 |
|---|---|
| `plugin.manifest-read` | 包根没有 `plugin.json`、超过 64KB、JSON 语法错误 |
| `plugin.manifest-schema` | 字段拼错 / 多写字段（strict）、缺必填项、重复贡献 id |
| `plugin.manifest-namespace` | 使用了 `com.kepcup/*` 或 `local.kepcup/*` |
| `plugin.files-path` | `dir` / `file` 指向不存在的路径、类型不对、符号链接、路径逃逸 |
| `plugin.files-limits` | 超过条目 / 单文件 / 解包体积上限 |
| `plugin.package-entries` | zip 层问题：`..`、绝对路径、符号链接、大小写重名、加密、ZIP64 |
| `plugin.skill-frontmatter` | `SKILL.md` 开头不是 `---`，或 frontmatter 缺 `name:` / `description:` |
| `plugin.connector-entry` | 连接器 `server.json` 没通过既有连接器校验（消息里带文件名与原始检查 id） |
| `plugin.connector-packages` | 连接器条目里有 `packages[]`，改用 `mcp` 贡献 |
| `plugin.connector-remote` | 连接器端点是 http / IP / localhost / 内网域名 |
| `plugin.connector-icon` | `_meta.icon` 指向的文件不在 `server.json` 同目录 |
| `plugin.mcpb-package` | `.mcpb` 不是合法 zip、缺 `manifest.json`、`manifest_version` 不支持、入口文件不在包内 |
| `plugin.mcp-http` | http 贡献 URL 不是公网 https；需要 OAuth 的远端请改连接器 |
| `plugin.mail-host` | 邮件主机是 IP / localhost / 不含点 / `.local` 等内网后缀 |

`--json` 输出可机读报告（`mode: "plugin"`、`schemaVersion: 1`），适合 CI；完整检查项见 [packages/app-validator/README.md](../../packages/app-validator/README.md#plugin-packages)。
