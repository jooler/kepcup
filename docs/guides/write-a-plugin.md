# 写一个 KepCup 插件

**适用范围**：你想把一组技能、连接、工具（MCP）、邮箱能力打包成一个 `.kepcup`，让别人在 KepCup
里安装；或你是编程 Agent，要为用户产出这样的包。读完本文（不需要读 KepCup 源码）你应该能写出、
校验、打包并本地安装一个含配置与实例能力的插件。
**前提**：本机有 Node.js ≥ 22.19；`kepcup-app` CLI 在 KepCup 仓库的 `packages/app-validator`
（`node packages/app-validator/dist/cli.js --help`）。

> 本文是插件格式的**唯一权威参考**，与实现逐条对齐（2026-10，D105 插件平台迭代）。
> 设计沿革见 [design/51-plugin-system.md](../design/51-plugin-system.md)；本文与其冲突时以本文为准。

---

## 1. 概念

**插件 = 声明式贡献包。** 包里没有任何可执行入口：宿主进程**绝不**加载、执行包内代码
（没有 `import` / `require` / `vm` / `eval` / `Worker`）。需要本地执行的能力只能以**内嵌 MCPB**
（`.mcpb`，由宿主的 MCP 安装器解包运行）提供；需要 OAuth 的远端服务做成**连接**贡献；
无需认证的公网 MCP 用 **http 工具**贡献；邮箱能力做成**邮件**贡献 + 实例。

### 1.1 能力类型

一个插件可同时携带五类贡献（每类数量有上限，见 §2）：

| 能力类型 | kind id | 用户界面叫它 | 落地方式 |
|---|---|---|---|
| 技能 | `skill` | 技能 | 安装即注入 Bot 的技能库（`plugin://` 来源标记） |
| 连接 | `connector` | 连接 | 进连接目录；用户逐账号连接（OAuth） |
| 工具 | `mcp` | 工具 | 内嵌 MCPB 解包运行，或登记远端 http server |
| 邮件 | `mail` | 邮件 | 实例供给规范：用户在插件卡上添加邮箱账号 |
| 即时通讯 | `im` | 即时通讯 / IM 账号 | 实例供给规范：用户扫码 / 填表添加 IM 账号（D107，设计 54） |

能力类型本身可扩展（注册表机制，§9 菜谱）；`format_version` 不因此变化。

### 1.2 贡献、实例、插件配置——三分

| | 谁创建 | 何时存在 | 值存哪里 |
|---|---|---|---|
| **贡献**（contribution） | 插件作者，写在清单里 | 安装即落地 | 技能库 / 连接目录 / MCP 设置 / 邮件账本行 |
| **实例**（instance） | 用户在插件卡「添加」 | 用户创建，卸载级联删除 | 非敏感值 → `plugin_instances` 表；敏感值 → secrets |
| **插件配置**（config） | 用户在插件卡「设置」 | 安装后随时 | 非敏感值 → `plugins.config_json`；敏感值 → secrets |

- 实例与配置的**表单都由清单声明的字段 schema 自动构建**（`config.fields` 与
  `instanceFields`，字段 schema 见 §2.3）——宿主生成 UI，开发者不写界面。
- 敏感值（`sensitive: true`）只进 secrets，永不出现在任何列表 / 快照 / 审计里；编辑表单
  显示「已设置」占位，留空提交 = 保留已存值。
- 实例的典型形态是邮箱 / IM 账号：一个插件可添加多个账号，账号跟人走而不跟 Bot 走，
  绑定到哪些 Bot 由用户决定。`instances: ['mcp']`（自定义工具实例）在后续版本开放，
  当前版本声明了也不会有可用的创建路径。
- **卸载插件 = 级联删除其全部实例**（先拆领域数据——如邮箱账号——再删行），卸载确认会明示。

### 1.3 信任分级与来源定级

| 来源 | 分级 | 用户会看到什么 |
|---|---|---|
| 本地安装（文件 / 文件夹） | `developer` | 「未审核」警示；连接器工具逐次确认、无持续授权；工具 server 标 developer |
| 自托管市场 | 最高 `community` | 自托管索引的签名与用户登记的公钥决定信任 |
| 官方市场 | `verified` / `community` | 索引里的策展分级；权限扩大时更新要重新同意 |

分级（tier）是**策展 / 来源元数据**，清单里写 `tier`、`permissions` 之类字段会被直接拒绝
（清单是 strict schema，§2）——权限永远从贡献内容推导，不采信包自述。

### 1.4 安装管线（市场与本地同一条）

校验（清单 strict schema + 包结构 + 各贡献校验）→ **同意卡**（用户看到推导出的权限：
技能清单、连接主机与 OAuth 范围、MCPB 启动命令 / 运行时 / sha256 / 必填配置、邮件能力概述）
→ 落盘（内容寻址目录 `{pluginsDir}/{ns}/{name}@{version}`）→ 登记（账本先行，可回滚）
→ 投影（按能力类型写进既有服务）。卸载按反序回滚；更新按能力类型逐个迁移并保留用户状态。
安装成功后宿主会弹「接入引导」：**插件的能力不会自动生效**——需要在 Bot 详情或项目组设置的
「插件」区块里**添加**它（右上角 `+`，或安装引导里的「立即添加到 Bot」快捷方式），对应 Bot
才能使用。Bot 详情只列已添加的插件，未添加的插件其技能、工具与账号对它不可见。

---

## 2. `plugin.json` 参考

### 2.1 完整示例

```jsonc
{
  "format_version": 1,
  "id": "io.github.alice/doc-tools",
  "name": "文档工具集",
  "icon": "icon.svg",
  "version": "1.2.0",
  "description": "处理 Markdown / DOCX 的技能与工具",
  "usage": "启用后还需要连接账号：在扩展中心完成 Acme 授权，并在 Bot 详情展开插件卡片勾选绑定该账号；邮件能力还需要在插件卡「管理」里添加邮箱账号并绑定，Bot 才能使用。",
  "author": { "name": "Alice", "url": "https://alice.example" },
  "homepage": "https://github.com/alice/doc-tools",
  "engines": { "kepcup": ">=0.5.7" },
  "platforms": ["darwin", "win32", "linux"],   // 缺省 = 全平台
  "config": {
    "fields": [
      { "key": "defaultRepo", "type": "string", "title": "默认仓库",
        "description": "形如 owner/name", "required": false }
    ]
  },
  "instances": ["mail"],                        // 仅与邮件贡献搭配（见 §2.2）
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
        "defaultPollSec": 300,
        "helpUrl": "https://www.fastmail.help/"
      }
    ]
  }
}
```

### 2.2 顶层字段表

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `format_version` | `1` | ✔ | 目前只能是 `1`（可加性契约见 §5.2） |
| `id` | string | ✔ | `{命名空间}/{名字}`：`/^[A-Za-z0-9][A-Za-z0-9.-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/`，3–200 字符（命名空间段可含点，多段反向域名可用）；同时是插件主键，同一 id 不能跨来源并存；`com.kepcup` / `local.kepcup` 是保留命名空间（小写比对） |
| `name` | string | ✔ | 1–100 字符，市场与卡片标题 |
| `icon` | string | ✔（市场发布） | 包内相对路径，必须是 `.svg` 或 `.png`（≤256 KiB；进入市场索引的图标需 ≤64 KiB）。插件列表、Bot 详情、扩展中心与**市场卡片**都显示它；缺省时宿主显示**默认图标**，`validate` 报 error，市场发布不允许缺图标（见 §2.4） |
| `version` | string | ✔ | semver（`1.2.0`、可带 `-beta.1` / `+build`）；≤64 字符 |
| `description` | string | 建议 | ≤1000 字符；用户在同意卡与市场卡看到的第一句话 |
| `usage` | string | ✔ | 1–500 字符，**启用说明**：启用之后还需要做什么才能用（「启用即可使用」/「需要连接账号」/「需要先添加账号再勾选绑定」）。用户在 Bot 详情操作插件 30 秒后，宿主会把操作状态连同这句话发给 Bot，由它决定是否提醒用户补做遗漏步骤；见 §2.5。新安装 / 发布必填（`validate` 与签名脚本拒绝空值）；2026-11-03 之前安装的旧版本清单允许缺省（回落空串）以便更新 |
| `author` | `{ name, url? }` | 建议 | `url` 必须是 https；帮助用户判断来源 |
| `homepage` | string | 建议 | https URL，≤500 字符 |
| `engines` | `{ kepcup }` | 依赖新字段时必填 | semver 范围（如 `">=0.5.7"`；当前应用版本以 `apps/desktop/package.json` 为准）；开发版宿主（`0.0.0`）跳过该检查。**清单用到旧宿主不认识的新字段（如 `usage`）时必须抬高下限**，否则旧客户端会先看到「可更新」再在解析阶段失败 |
| `platforms` | `['darwin'\|'win32'\|'linux']` | | 缺省 = 全平台；不匹配则拒绝安装（`PLUGIN_INCOMPATIBLE`） |
| `config` | `{ fields: PluginField[] }` | | ≤32 个字段，key 查重；见 §2.3 |
| `instances` | `['mail'\|'mcp'\|'im']` | | ≤4 个、去重；声明哪些**纯实例能力**（§1.2） |
| `contributions` | object | 见下 | 五类贡献数组；可整体省略（纯实例插件） |

- **「至少有一类贡献」已放宽为「贡献或 `instances` 至少其一」**；纯实例插件（只有
  `instances`，如未来 `app.kepcup/custom-mcp`）合法。
- 每类贡献数量上限：技能 50、连接 20、工具 10、邮件 10——但**邮件贡献实际只能 1 份**
  （必须与 `instances: ['mail']` 配对，见下）。
- 邮件贡献的配对约束（schema 强制）：**邮件贡献 ≤1 份**且必须伴随 `instances: ['mail']`；
  反过来 `instances: ['mail']` 必须伴随一份邮件贡献（否则实例表单永远无法满足创建）。
- 清单 ≤ 64KB；`.kepcup` 上限 512MB / 解包 500MB / 条目 20,000 / 单文件 200MB；不支持 ZIP64
  与加密。清单是 strict schema：**拼错 / 多写任何未声明字段（包括 `tier` / `permissions`）
  都会被拒绝**。
- 包内 `dir` / `file` 一律是**相对 POSIX 路径**：非空、≤300 字符、不以 `/` 开头、无反斜杠 /
  冒号 / 控制字符、任何一段都不能是空 / `.` / `..`；包内不允许符号链接。
- `contributions.mcp[].id` 与 `contributions.mail[].id`：`[a-z0-9][a-z0-9-]{0,31}`，包内查重。
  mcp 贡献 id 参与 server id 推导（§3.3），更新前后保持不变才能保住用户的工具审批 / 锁定。
- 技能展示字段（`displayName` / `summary` / `icon` / `section` / `tryIt` / `vendored`）只给
  内置插件用，第三方插件可省略，界面回落到 `SKILL.md` 的 `name` / `description`。
- 包根 `README.md`：建议提供，插件详情页展示。`icon` 声明的文件在包内任意安全相对路径
  （推荐放包根 `icon.svg` / `icon.png`）；连接器插件可以直接指向已有的
  `connectors/<slug>/<slug>.svg`，不必再复制一份。

### 2.3 字段 schema（`PluginField`）——config、实例、MCPB 共用

`config.fields`、邮件 `instanceFields`、MCPB `user_config` 三者共用同一套字段 schema 与同一套
自动表单。全字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `key` | string | ✔ | `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`；同一字段集内查重 |
| `type` | string | ✔ | `string` \| `number` \| `boolean` \| `directory` \| `file` |
| `title` | string | ✔ | 1–200 字符，表单标签（给用户看的字段名） |
| `description` | string | | ≤2000 字符，表单下的辅助说明 |
| `required` | bool | | 缺省 `false`；保存时必填项必须有值（提交值 / 已存敏感值） |
| `sensitive` | bool | | 缺省 `false`；`true` = 只进 secrets，回显只给「已设置」占位 |
| `multiple` | bool | | 缺省 `false`；`true` = 值是数组（表单渲染为多行文本，每行一个） |
| `default` | 标量 / 标量数组 | | 语义分场景，**见下框** |
| `min` / `max` | number | | 仅 `type: "number"`：值域约束（保存时校验，也随安全投影进表单） |

> **`default` 的确切语义（最容易理解错的地方）**
>
> - **插件 `config` 与实例字段**：`default` **不会**预填表单、**不会**物化进
>   `config_json`。它只参与必填判定：字段留空 + 声明了 default = 合法（不算缺必填）。
>   将来读取该配置的运行时消费方（能力类型适配器 / materializer）**必须自己回退清单里的
>   default**——宿主不代劳、不落库。宿主校验器会检查 default 与 `type` / `min` / `max`
>   一致（不一致给 warning）。
> - **MCPB `user_config`**：`default` 会在**安装表单里预填**并随安装提交生效（场景不同）。
> - **任何 `sensitive: true` 的字段都不要声明 default**（校验器警告）：敏感值只能来自用户
>   输入并落到 secrets，manifest 里的「默认密码」既不安全也永远不会被读取。

> **config 的运行时消费方（重要预期管理）**：当前版本里，config 值的**自动**消费随能力类型
> 适配器落地（例如未来邮件适配器读「轮询间隔」）。**技能贡献没有运行时 config 读取路径**——
> 宿主不会把 config 值注入技能正文；技能插件声明 config 时，请在 `SKILL.md` 里指示 Bot
> 「若配置了 X 则…，否则向用户确认」（用户填写的值对 Bot 不可见，Bot 不能读
> `plugins.config.get`）。声明 config 仍然有意义：它给用户一个稳定的设置入口与存储。

**宿主自动表单的渲染对照**（开发者据此预期 UI）：

| 字段声明 | 渲染 | 校验 |
|---|---|---|
| `string` | 单行文本框 | 长度 ≤10000 |
| `number` | 数字输入 | 整数性由消费方定；`min` / `max` 保存时校验 |
| `boolean` | 复选框 | 恒视为已填 |
| `directory` / `file` | 本机路径选择器 | 宿主**只当字符串存储，不做存在性 / 安全校验**——消费该值的适配器 / materializer 负责路径校验（存在性、可读性、沙箱白名单） |
| `multiple: true` | 多行文本（每行一个值） | 每个值按 `type` 校验 |
| `sensitive: true` | 密码框；已保存显示占位 | 留空提交 = 保留已存 secret；必填敏感字段无已存值则拒绝 |

### 2.4 插件图标（市场插件必须有自己的图标）

插件是用户看到的一个**实体**，市场卡片、已安装列表、添加弹框与 Bot 详情都只以插件为
单位展示，因此每个提交到市场的插件都必须有能代表自己的图标：

- 在 `plugin.json` 里写 `"icon": "icon.svg"`（或 `.png`），文件放进包里；建议 64×64 或
  更大、正方形、透明或纯色背景，避免小尺寸下糊成一团。
- 支持 `.svg` / `.png`，单文件 ≤256 KiB；宿主按扩展名与文件头校验，读不到 / 格式不对 /
  超限都回落到**默认图标**（拼图），不会阻断安装，但 `validate` 会报 error。
- **没有 `icon` 的插件不能提交到市场**：`validate` 的 `plugin.icon` 直接报 error。运行期
  仍保留默认图标兜底——历史索引或手工构建的索引里确实没有图标时，市场卡片显示拼图默认
  图标，不会退回名称首字。
- **市场卡片图标内联在签名索引里**：签名脚本读取包内图标并写入 `summary.icon`
  （`data:image/…;base64`，原始文件 ≤64 KiB）。图标超过 64 KiB 或格式不可用时，签名直接
  失败 / `validate` 给 warning，避免市场卡片静默回落。市场索引导出图标不发起任何远程图片
  请求；安装后 `PluginSummary.iconDataUri` 仍从插件目录读取同一文件。
- 超过 64 KiB 的图标本地安装仍可用（上限 256 KiB），但不会进入市场索引；发布前请压缩到
  64 KiB 以内。
- `kepcup-app init plugin` 生成的骨架自带一个占位 `icon.svg`，替换成自己的图标即可。

### 2.5 启用说明（`usage`，必填）

`usage` 是**插件写给用户 / Bot 的激活指引**，回答「启用这个插件之后，还要做什么它才真正
可用」。用户把插件添加到 Bot 时，能力装配立即按启用集生效，但很多插件还需要额外步骤
（连接 OAuth 账号、在插件卡片里添加邮箱 / 微信账号、再勾选绑定到 Bot）。这些步骤漏掉时，
用户会以为已经生效、Bot 却调不到能力。

- 宿主在用户**最后一次操作插件 30 秒后**，把最终状态（启用了哪些插件、各自是「就绪」还是
  「尚未连接账号 / 已添加账号但未勾选绑定」）连同 `usage` 一起作为一条内部事件发给 Bot。
- Bot 看到全部就绪 → 保持静默（`skip_reply`）；发现遗漏 → 主动发一条简短消息提醒用户
  在哪里补哪一步（例如「展开微信插件卡片，勾选绑定」）。
- 因此 `usage` 要写**可执行的动作**，不要写营销文案：说明是「启用即用」，还是「需要先
  连接 / 添加账号再勾选绑定」，以及用户应该在哪里操作（扩展中心 / 插件卡片「管理」/
  Bot 详情插件区块）。
- 1–500 字符；**新安装 / 市场发布必填**（`kepcup-app validate` 报 `plugin.usage` error、签名
  脚本拒绝空值）；2026-11-03 之前安装的旧版本清单缺该字段仍可读取与走市场更新（回落空串），
  但本地目录 / 文件重装同样要补上 `usage`（安装管线 `requireUsage`）。
- 宿主会把它按不可信文案清洗（控制字符、双向控制符、长度），放进 `<untrusted>` 块，
  不会当作指令执行。
- 示例：
  - 技能 / 内置工具插件：`"启用即可使用：添加到 Bot 后，Bot 会在匹配的任务里自动加载该技能，无需再连接账号或勾选其他选项。"`
  - 连接器插件：`"启用后还需要连接账号：在扩展中心完成 Notion 授权，并在 Bot 详情展开插件卡片勾选绑定该账号，Bot 才能读写页面与数据库。"`
  - 邮件插件：`"启用后还需要添加账号：在扩展中心 → 已安装 → 邮箱插件卡「管理」里添加邮箱账号，再在 Bot 详情展开插件卡片勾选绑定该账号，Bot 才能收发邮件。"`
  - IM 插件（微信）：`"启用后还需要扫码添加微信账号（扩展中心 → 已安装 → 微信 →「管理」），并在 Bot 详情展开微信插件卡片勾选绑定；绑定后微信消息才能唤醒 Bot，勾选「同步消息到此微信」后 Bot 的回复才会转发回微信。"`

---

## 3. 各能力类型的接口契约

（开发者视角的「宿主提供的接口」；每类附「用户看到什么」。）

### 3.1 技能（skill）

包内目录结构：标准 Agent Skill 文件夹，`SKILL.md` 必须存在且以 `---` frontmatter 开头：

```markdown
---
name: hello
description: 用一句话说明这个技能做什么、什么时候该用。
---

# Hello

步骤、注意事项与示例。安装时宿主会解析 frontmatter、
扫描运行时依赖（shebang / requirements.txt / package.json 推断）
并做沙箱兼容检查。
```

- frontmatter 缺 `name:` / `description:`、没有闭合 `---` 都会被拒（`plugin.skill-frontmatter`）。
  frontmatter 是**扁平 `key: value` 行**（列表用 `- item` 或行内 `[a, b]`，不支持嵌套 YAML）。
  `name` **约定**用 Agent Skills 的名字规则：小写 `a-z` / 数字 / 连字符，无连续或首尾连字符，
  ≤64 字符，并与目录同名。注意宿主**不强制**这条（非规范名照常安装，只是会带一条诊断）——但
  技能名是 `<skills>` 里的标识、也是 `plugin://{pluginId}/{name}` 来源标记的末段，改它等于换技能
  （重装后旧名技能会被回收）。`description` 超过 1024 字符会被截断；`metadata` 等其他键允许存在
  并交给扫描器，宿主只消费它认识的。
- 运行时依赖在**同意卡**上展示（`runtimeDeps` + 本机是否可用）；不兼容不阻断安装——技能以
  「不兼容」状态登记、同意卡标注，依赖由用户在「设置 → 环境」安装。
- **注入语义（按 Bot 启用）**：插件技能带 `plugin://{pluginId}/{skillName}` 来源标记，只有
  **所属插件 ∈ 该 Bot 的启用集**（Bot 详情「插件」区块添加了该插件；项目会话叠加项目组
  启用集）才进 `<skills>` 提示段与沙箱可读目录。装了 ≠ 全员可见。
- **用户看到**：同意卡列出技能名与描述；Bot 详情「插件」区块只列已添加的插件（`+` 弹框
  添加、卡片右下角移除）；技能管理页里来源标「插件」，卸载走插件整体。

### 3.2 连接（connector）

`connectors/<slug>/server.json` = 开放平台 `server.json` 子集 + `_meta`，**按安装器的严格
schema 写全**（`kepcup-app validate` 用同一 schema 检查，缺字段报 `plugin.connector-entry`）：

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
      "icon": "acme.svg",                    // 必须与 server.json 同目录
      "category": "project",
      "tier": "community",                   // 插件来源会改写 tier，填 community 即可
      "auth": {
        "kind": "oauth",
        "registration": "auto",
        "clientRef": null,
        "scopes": { "default": [], "write": [] }
      },
      "toolPolicy": {},
      "skills": [],
      "ui": false,
      "privacyPolicy": "https://acme.example/privacy",
      "releaseGate": "plugin"                // 必填；安装时 KepCup 一律改写为 "plugin"
    }
  }
}
```

- 端点必须**公网 https**（不能是 IP、`localhost`、内网域名）且至少一个；`packages[]` 必须
  为空——本地执行改用 `mcp` 贡献。
- **多账号语义**：一个连接器可连接多个账号（账号 = 实例思想在连接上的既有形态）；Bot 绑定
  走 `app_connection_ids` 细选，同一 Connector 至多绑一个账号；贡献插件未启用时该连接对该
  Bot 隐藏。宿主对所有插件统一提供「连接另一个账号 / 更换账号 / 移除」，不需要清单声明
  单账号或多账号。
- **账号识别（同一账号去重）**：授权完成后 core 优先用 OIDC `id_token` / userinfo 识别账号；
  拿不到稳定标识时，如果服务提供只读的「当前用户」工具，可在 `_meta.whoami` 声明它：
  `{ "tool": "get_user", "arguments": { … }, "labelPath": "email", "subjectPath": "id" }`。
  core 只调用被判定为只读的工具，用 `subjectPath`（稳定账号标识）去重——同一账号再次授权
  复用原连接行，`labelPath` 作为账号显示名。没有稳定标识（令牌里没有 `sub`，也未声明
  `subjectPath`）时，每次授权都会新建一条连接（显示名取可用标签，否则 `{title} #{n}`），
  不会复用旧行。
- **授权未完成的连接不是账号**：`connecting` 状态（含工具复核中）的连接不出现在「已连接」、
  Bot 的账号候选或目录账号数里；Bot 只能绑定走完流程的账号，账号的增删改都在扩展中心完成。
- **用户看到**：同意卡列出 slug、主机与 OAuth 范围；扩展中心「连接」管理与逐账号 OAuth；
  `developer` 级插件连接的工具逐次确认、无持续授权。

### 3.3 工具（mcp）

三种形态：

- **内嵌 MCPB**（`kind: "mcpb"`）：标准 MCPB 包（zip + `manifest.json` +
  `server.entry_point`；`manifest_version` 支持 0.1 / 0.2 / 0.3）。由宿主的 MCPB 安装器
  解包到 `toolchains/`；运行时（Node / Python / uv）由用户在「设置 → 环境」安装，缺失会在
  同意卡标出。`user_config`（与 §2.3 同 schema）在**安装表单**填写，敏感值进 secrets。
- **远端 http**（`kind: "http"`）：`url` 必须公网 https、无认证。需要 OAuth 的远端请做成
  连接贡献。
- **http 模版 / 实例**（P4-M2）：清单声明 `instances: ['mcp']` 时，http 贡献从「固定投影的
  server」变成**实例供给规范**（与 mail 同语义，见 §3.4）——每个用户实例落一条自己的
  streamable-http server，凭据由用户在实例表单粘贴（只进 secrets）。mcpb 贡献不支持
  实例化（schema 拒绝）；http 模版至多一份（0 份 = 纯实例通用插件）。

  | 声明 | 形态 | 用户表单 |
  |---|---|---|
  | `url` **非空** | 厂商模版（锁定端点） | `label`（选填）/ 各 header 值字段（sensitive，值只进 secrets）+ 插件 `instanceFields` |
  | `url` **留空 `""`** | 通用模版（自填端点） | 上述 + `url` 必填实例字段（`urlSensitive: true` 时 URL 本身按敏感处理） |

  - `auth: 'headers'` 必须至少声明一个 `headers: [{ name, key?, scheme? }]`（`key` 是提供该
    header 值的实例字段键，缺省 = header 名小写）；`auth: 'none'` 不得声明 headers。
  - **凭据方案 `scheme`（2026-11-12）**：header 模板可声明 `scheme`，约定「这个 header 用
    哪种凭据方案」，归一化由宿主统一做，插件不用写代码：
    - 可选值：`'bearer'`（当前唯一）。语义 = 该 header 的值是**裸凭据**，发送时统一成
      `Bearer <credential>`；
    - **保存侧**：实例表单写入的 secret 去掉用户可能自己粘的前缀与前导空白，只存裸值
      （存储形态单一，不会出现 `Bearer Bearer xxx`）；
    - **发送侧**：组请求头时补 `Bearer `；已带前缀（大小写不敏感、容忍多余空格 / 换行）
      不重复叠加；空值 / 纯空白不补成 `Bearer `；
    - **边界**：只影响显式声明 `scheme` 的 header。未声明 `scheme` 的 header、其他 header
      （API key 等）与其他 MCP server（含用户手装）原样存储、原样发送，行为不变；
    - 插件 README / `usage` 据此写「粘贴服务商发放的裸 token 即可，前缀由宿主补」，
      **不要**让用户手写 `Bearer `。

    示例（腾讯文档 MCP 的实际写法）：

    ```json
    {
      "kind": "http",
      "id": "docs",
      "url": "https://docs.qq.com/openapi/mcp",
      "auth": "headers",
      "headers": [{ "name": "Authorization", "key": "token", "scheme": "bearer" }]
    }
    ```

    清单里填未知方案会被 schema 拒绝（`plugin.manifest-schema`，路径形如
    `contributions.mcp.0.headers.0.scheme`）；校验器对合法声明给一条
    `plugin.mcp-header-scheme` 提示，便于核对文档口径。新增方案要动四处：
    `packages/shared/src/domain/mcp-header.ts` 的 `MCP_HEADER_SCHEMES` 与
    `normalizeMcpHeaderValueForStorage` / `normalizeMcpHeaderValueForWire` 两个分支、
    `packages/core/src/mcp/header-scheme.ts`（发送侧接线的类型引用）与本文档。
  - **内置实例字段键**（`instanceFields` 不得重名）：`label` / `url` / 各 header 的
    `key`。
  - 实例 server id = `plg_` + sha256(`{pluginId}#{instanceId}`) 前 12 位；实例删除 =
    server、header secrets 一起清场。**用户看到**：插件卡「管理」= 实例列表 +
    添加 / 编辑 / 删除表单（编辑即 URL 续期 / 令牌轮换）。

**server id 稳定性**：插件贡献的 server id = `plg_` + sha256(`{pluginId}#{id}`) 前 12 位——
跨版本更新不变，因此用户的工具审批、锁定策略与 Bot 级选择全部保留。**贡献 id 就是稳定性
契约**：更新时改 `mcp[].id` 等于换了一个 server。

**受管字段（`PLUGIN_MANAGED`）**：插件 server（含实例来源）的 `transport` / `command` /
`args` / `env` / `url` / `headers` / `auth` / `source` / `tier` 只能由插件生命周期改写；
用户在 MCP 设置里直改这些字段会被拒绝（`name` / `enabled` / `autoApprove` / `toolPolicies` /
`description` 可自由改）。退出方式：贡献 server = 卸载 / 停用插件；实例 server =
在插件卡更新 / 删除实例。

**用户看到**：同意卡展示启动命令、运行时可用性、sha256、必填 `user_config`（mcpb）、
远端主机（固定 http）或供给规范（模版）；扩展中心插件卡「管理 · 工具」只列**该插件**的
server / 实例；工具的审批 / 风险 / 锁定语义与手装 server 完全一致（插件化只影响可见性与
生命周期）。

### 3.4 邮件（mail）

邮件贡献 = **实例供给规范**（不是能力单元本身）：声明一份「添加邮箱」的默认值与锁定项，
账号由用户在插件卡上逐个添加（实例）。schema 强制恰一份贡献 + `instances: ['mail']`。

| 声明 | 形态 | 用户表单 |
|---|---|---|
| `imap.host` / `smtp.host` **非空**（成对） | 厂商插件（锁定端点） | 地址 / 登录用户名（选填）/ 授权码 + 插件 `instanceFields` |
| `imap.host` / `smtp.host` **留空**（成对） | 通用插件（自填端点） | 上述 + 收发服务器 / 端口 / 加密方式六个**必填**实例字段 |

- 端点锁定只能成对声明（只锁一侧是清单错误，schema 拒绝）；主机必须是公网域名（不能是
  IP / `localhost` / `.local` / `.internal` 等）。
- `defaultMode`（`auto` / `poll_only`）、`defaultPollSec`（≥60）、`minPollSec`（≥60）作为
  新账号种子；**全局 60 秒轮询下限是硬限制**，清单只能抬高不能压过。
- `instanceFields`（≤16）追加在 kind 内置字段之后；不得与内置键重名：`address` / `username` /
  `password` / `imapHost` / `imapPort` / `imapSecure` / `smtpHost` / `smtpPort` / `smtpSecure`。
- 授权码（password）恒为敏感字段，只进 secrets；一个账号可绑定多个 Bot；**所属插件未启用时
  账号对该 Bot 不可见**（工具注册、`<mail_accounts>` 段与工具内清单三处同源过滤）。
- **用户看到**：同意卡显示 `label` 与端点主机；插件卡「管理」= 账号列表 + 添加 / 编辑 / 删除
  表单（宿主按 §2.3 字段自动构建）；删除插件 = 级联删除全部账号、绑定与授权码。

### 3.5 即时通讯（im）

IM 贡献同样是**实例供给规范**（D107，完整契约见 [54-im-channel.md](../design/54-im-channel.md)）：
声明 `instances: ['im']` + 恰一份 `contributions.im`，账号由用户扫码（`setup: 'qrcode'`）或
填表（`setup: 'secret'`）添加；绑定到 Bot 的账号才参与入站唤醒与出站转发。

| 声明 | 说明 |
|---|---|
| `transport` | 宿主会话实现（首发 `ilink` = 个人微信 iLink） |
| `apiBase` | `transport` 需要的固定端点（https 公网，schema 校验锁定） |
| `features` | `inbound` / `outbound` / `media`（声明面，宿主按 transport 实际实现裁剪） |
| `instanceFields` | 追加在 kind 内置字段之后的表单字段（≤16；`qrcode` 建号不得声明 sensitive） |

- **用户看到**：安装同意卡显示通道名称 / 端点 / 收发能力；插件卡「管理」= IM 账号列表 +
  扫码添加；Bot 详情插件区 = 账号勾选绑定与「同步消息到此微信」开关。
- `usage` 必须写清「扫码 → 勾选绑定 → 按需开启转发」三步，否则用户只添加了插件、没有绑定
  账号时能力不会生效（宿主会在 30 秒后提醒 Bot，由 Bot 告诉用户补哪一步）。

---

## 4. 本地开发循环

```sh
# 0. 生成骨架（--id 缺省 io.github.your-name/<目录名>；骨架含一个示例 config 字段）
node packages/app-validator/dist/cli.js init plugin ./my-plugin --id io.github.alice/doc-tools

# 1. 编辑 plugin.json 与各贡献（§2 / §3）

# 2. 本地自检：完全离线、不执行包内代码（--json 出机读报告）
node packages/app-validator/dist/cli.js validate ./my-plugin

# 3. 边改边调试：扩展中心 → 已安装 → 从文件夹安装…（重装同 id 即更新）
#    安装成功后的引导弹框提示去 Bot 详情「插件」区块启用，能力才对该 Bot 生效

# 4. 打包（对排除规则之后、将要装进包里的内容做同样校验；有 error 不产出文件）
node packages/app-validator/dist/cli.js pack ./my-plugin --out ./my-plugin.kepcup

# 5. 验证产物（可再次 validate，或直接安装）
node packages/app-validator/dist/cli.js validate ./my-plugin.kepcup
```

要点：

- `validate <目录>` 对目录**原样**检查（不排除任何路径、拒绝符号链接）：含 `node_modules` 的
  开发目录请校验 `pack` 产物。
- `pack` 输出**可复现**：条目排序、时间戳固定，同目录同 Node 版本两次打包 sha256 相同。
  默认排除 `.git/`、`node_modules/`、`.DS_Store`、`*.kepcup`、`.kepcup-ignore` 自身；
  `.kepcup-ignore` 每行一个相对路径或 `目录/`，`#` 注释，不支持通配符。
- 把 `kepcup-app` 加成 bin 后可直接 `kepcup-app validate ./my-plugin`。

**调试建议**：从最小贡献起步（先一个技能跑通安装 → 启用 → 注入），再逐类添加；每次改动后
`validate` 保持零 error。config / 实例的落点验证：插件卡「设置」保存后重开应回显（敏感字段
只回「已设置」占位）；`plugins.config.get` / `plugins.instances.list` RPC 可机读核对。

---

## 5. 版本与兼容

### 5.1 版本与环境

- `version` 用 semver；市场更新缺省取索引中**最高兼容版本**。
- `engines.kepcup` 用 semver 范围声明兼容的宿主版本；不满足 → `PLUGIN_INCOMPATIBLE`
  （开发版宿主 `0.0.0` 跳过）。
- `platforms` 缺省全平台；声明后在不支持的系统上拒绝安装。

### 5.2 可加性契约（重要）

`format_version` 只在**破坏性**变更时 +1；新增能力类型、新增清单字段一律走「可选字段」，
`format_version` 不变。因此：

- 旧宿主遇到不认识的字段 / 能力类型 → 报 **`PLUGIN_UPGRADE_REQUIRED`**（「请升级 KepCup」），
  绝不静默忽略。
- 给插件作者的含义：**只加不改**就能兼容旧宿主；一旦依赖新字段，记得抬高
  `engines.kepcup` 下限，让旧宿主在安装前就给出可读的升级提示。

### 5.3 更新与再同意

- 市场插件：`plugins.update`（版本可选）；本地插件：重装（`install` 同 id 即走更新流）。
- 权限以**token**表达（技能名 / 连接 slug / 主机 / OAuth 范围 / MCPB / 运行时 / 配置键 /
  邮件）；新版本「只删不增」= 不扩大，静默更新；**新增任何一个 token = 权限扩大**，需要用户
  重新同意（`acknowledgeDiff`），同意面板列出新增项（如「新增网络主机 api.example.com」）。
- 更新保留：插件 config、实例与 secrets、用户状态（连接账号 / 工具策略 / Bot 启用集）。
  更新删改了 config 字段：表单按**当前清单**投影，已存的陈旧键在下次保存时自然清除。
- 卸载：级联删除全部实例（先经各能力的 materializer 拆领域数据，幂等）与 secrets。

---

## 6. 安全规则

**包内不允许的东西**（校验器与安装器双层强制）：

- 任何会被宿主执行的代码形态——宿主根本不加载包内文件；本地执行只能走内嵌 MCPB（其启动
  配置在同意卡明示）。
- 清单自述的信任字段（`tier` / `permissions` 等）——strict schema 直接拒绝。
- 符号链接、路径逃逸（`..` / 绝对路径 / 反斜杠 / 冒号 / 控制字符）、zip 层攻击
  （大小写重名、加密、ZIP64）。
- 超限：清单 64KB、条目 20,000、单文件 200MB、解包 500MB、`.kepcup` 512MB。
- 面向主机的端点必须公网 https（连接 / http 工具）或公网域名（邮件）；内网 / 环回地址拒绝。

**权限从贡献推导，永不自述**：安装前宿主把贡献归一化为权限 token（§5.3）并展示在同意卡；
`description` / `author` / `homepage` 缺失会有 warning（帮助用户判断来源）。

**文案清洗**：清单与贡献里的用户可见文本（名称、描述、技能名等）在展示前经过统一清洗
（控制字符 / 双向书写标记 / 零宽字符折叠或移除）。插件作者仍应：名称与描述写人话，
**用户可见文案不出现协议词汇**——具体指：`OAuth`、`MCP`、`IMAP`、`SMTP`、`stdio`、
`sse` / `streamable-http` 这类传输与授权协议名，不要出现在插件名、插件与贡献的
`description`、字段 `title` / `description` 里（宿主自己的界面也遵守同一条规则；说
「连接 Notion」「收发邮件」而不是「OAuth 连接」「IMAP 收信」）。**适用范围是展示文本**：
`SKILL.md` 正文是给 Agent 的指令、不是用户可见文案，写 `curl https://api.github.com`
这类内容完全没问题；协议细节出现在同意面板与开发文档（本文）里。

**好的同意卡描述怎么写**：一句话说清「装了能干什么 + 会访问哪些外部服务 + 是否本地执行」。
例如：「连接 Notion：授权后 Bot 可以读写你的 Notion 页面（OAuth，notion.so）」；
「本机转换 docx：内嵌工具，在本机运行，不需要网络」。不夸大能力，不隐藏数据流向。

---

## 7. 发布到官方市场

官方市场 = 仓库 `plugins/` 目录（每个子目录一个插件源）+ 签名索引 + 内容寻址 R2 包体：

1. **提交**：向仓库 `plugins/<你的插件>/` 发 PR。审查点：贡献内容与文案、端点与 OAuth 范围、
   是否值得 `verified`。
2. **策展**：维护者在发布 catalog（`[{ file, tier, summary }]`）里给每个包定
   `verified` / `community`（tier 只来自策展，绝不来自包）；`summary` 提供市场卡的
   名称 / 描述 / 作者。市场卡图标**不写在 catalog 里**：签名脚本从包内 `icon` 读取并内联
   到索引条目（`summary.icon`，原始文件 ≤64 KiB），保证卡片图标与包内图标一致。
3. **打包 + 签名 + 部署**（维护者操作，完整命令见 [plugins/README.md](../../plugins/README.md)
   与 [infra/cloudflare/plugins/README.md](../../infra/cloudflare/plugins/README.md)）：
   `pack` 全部插件 → `infra/cloudflare/sign-plugins.sh` 用 Ed25519 私钥对 `index.json`
   原始字节签名（keyId `kepcup-plugins-2026-1`；索引条目携带由清单派生的
   `capabilitySummary` 一句话概述与内联 `summary.icon`）→ 包体按 `{sha256}.kepcup` 传
   R2（`pkg.kepcup.com`）→ 索引部署到 `dl.kepcup.com/plugins/v1/`。`--verify` 本地验签
   留档。声明了 `icon` 但文件缺失 / 格式不可用 / 超过 64 KiB 时签名失败；完全没声明图标
   时签名告警并在索引里留空，卡片回落默认图标。
4. **撤销与轮换**：索引 `revoked` 数组支持 `warn` 标记与 `disable` 自动停用；密钥轮换走
   公钥列表（`PLUGIN_INDEX_PUBLIC_KEYS`）追加 + `validFrom` / `validUntil` 窗口。

**社区自托管市场（简述）**：任何 https 端点提供同格式签名索引即可；用户在设置里登记自建
端点与**自己的公钥**（信任根是用户登记的 key，不是官方 key），此类条目信任封顶 `community`，
不会获得 `verified`。

---

## 8. 给编程 Agent 的操作指南

**最短路径**（一步一命令；工作目录 = 仓库根）：

```sh
node packages/app-validator/dist/cli.js init plugin /tmp/my-plugin --id io.github.<you>/<name>
# 编辑 /tmp/my-plugin/plugin.json（§2）与贡献（§3）
node packages/app-validator/dist/cli.js validate /tmp/my-plugin          # 必须零 error
node packages/app-validator/dist/cli.js pack /tmp/my-plugin --out /tmp/my-plugin.kepcup
# 交付 /tmp/my-plugin.kepcup（或目录路径，用户在扩展中心「从文件夹安装」）
```

**自检清单**（交付前逐条过）：

- [ ] `validate --json` 零 error（warning 逐条看：`manifest-metadata` 缺描述/作者/主页/engines、
      `readme` 缺 README、`icon` 图标超过 64 KiB 市场化上限、`field-default` default 用法
      问题——都应修掉而不是忽略）。
- [ ] `usage` 写清「启用之后还要做什么」（启用即用 / 连接账号 / 添加账号再勾选绑定），并
      写明在哪个入口操作；用到新字段的清单 `engines.kepcup` 已抬到支持它的最低版本。
- [ ] 清单只含 §2.2 表里的字段；id 不用保留命名空间；每类贡献数量与路径约束满足。
- [ ] `description` 写了「装了能干什么」的一句话（用户在同意卡读它）；含 config / 实例的
      插件，每个字段的 `title` / `description` 用用户能懂的话（不含协议词汇）。
- [ ] 技能 `SKILL.md` frontmatter 有 `name` + `description`；连接器 `server.json` 按 §3.2
      写全（含 `releaseGate`）；MCPB 是合法 zip 且含 `manifest.json`。
- [ ] 敏感字段标了 `sensitive: true` 且没有声明 default；必填字段想清楚 default 回退语义
      （§2.3 框注）。
- [ ] 有自己的图标：`icon` 指向包内 `.svg` / `.png`，市场发布用图标 ≤64 KiB（本地安装上限
      256 KiB），`plugin.icon` 为 info 而不是 warning / error（§2.4）。
- [ ] README.md 在包根。

**常见错误与修复**：

| 检查项 / 错误码 | 常见原因与修法 |
|---|---|
| `plugin.manifest-read` | 包根没有 `plugin.json`、超过 64KB、JSON 语法错误 |
| `plugin.manifest-schema` | 字段拼错 / 多写（strict）、缺必填、重复 id、config 字段 key 重复、邮件贡献与 `instances: ['mail']` 不配对——消息里带路径，对照 §2 修 |
| `plugin.usage` | 缺少启用说明 `usage`（新包必填）：写清启用后还要做什么、在哪里操作（§2.5） |
| `PLUGIN_UPGRADE_REQUIRED` | 清单含当前宿主不认识的新字段 / 新能力类型：升级 KepCup，或去掉新字段 |
| `plugin.manifest-namespace` | 用了 `com.kepcup/*` 或 `local.kepcup/*` |
| `plugin.files-path` | `dir` / `file` 指向不存在的路径、类型不对、符号链接、路径逃逸 |
| `plugin.files-limits` / `plugin.package-entries` | 超限；zip 层问题（`..`、绝对路径、符号链接、加密、ZIP64） |
| `plugin.skill-frontmatter` | `SKILL.md` 开头不是 `---`，或缺 `name:` / `description:`，或缺闭合 `---` |
| `plugin.connector-entry` | `server.json` 没按严格 schema 写全（常缺 `releaseGate`）或本身没过连接器检查 |
| `plugin.connector-packages` / `-remote` / `-icon` | 有 `packages[]`；端点非公网 https；图标不在 `server.json` 同目录 |
| `plugin.mcpb-package` | `.mcpb` 不是合法 zip、缺 `manifest.json`、`manifest_version` 不支持、入口不在包内 |
| `plugin.mcp-http` | http 贡献 URL 非公网 https；要 OAuth 的远端改做连接贡献 |
| `plugin.mail-host` | 邮件主机是 IP / localhost / 不含点 / 内网后缀 |
| `plugin.icon` | 未声明 `icon`（市场发布必须补）；声明了但文件缺失 / 不在包内 / 不是 `.svg` / `.png` / 超过 256 KiB；市场索引内联图标超过 64 KiB 时给 warning |
| `plugin.field-default`（warning） | `default` 与类型 / min-max 不符；sensitive 字段声明了 default |
| 安装后「插件能力没生效」 | 正常——插件需要在 Bot 详情「插件」区块用 `+` 添加（或项目组设置）；用安装引导弹框的「立即添加到 Bot」 |

---

## 9. 附：宿主侧菜谱——新增一类能力类型

（给 KepCup 宿主开发者；插件作者无需关心。机制目标是：任何一步都不触碰其他类型与既有插件。）

1. **shared 清单**：`contributions` 加一个可选字段（additive，`format_version` 不变；
   strict schema 下旧清单不受影响）。
2. **core 注册表**：实现 `CapabilityKindAdapter`（`packages/core/src/plugins/kinds.ts`）并
   追加进 `CAPABILITY_KINDS`——投影顺序、覆盖率测试、同意项映射全部由注册表派生。
3. **四个 per-kind 手工点**（注册表派生不了、必须逐一核对）：
   ① shared `PLUGIN_INSTANCE_KINDS`（若可实例化）；② `PluginInstanceStore.countsOf` 的
   `kind in (…)` 计数列表；③ `pluginCapabilitySummary` 的该 kind 文案与
   `pluginCapabilitySummaryFromCategories` 的标签；④ `kinds.ts#mergeConsentItems` 的
   consent key → items 数组收口。
4. **实例落地**：如需实例，实现 `InstanceMaterializer` 并
   `registerMaterializer(kind, …)`（拆数据必须幂等；崩溃窗口参照 mail 的启动对账）。
5. **渲染端**：该 kind 的卡片管理视图适配与 i18n（用户可见类别名，协议不可见）。
6. **迁移**：若扩展 `plugin_instances.kind` 的 CHECK，新增迁移（SQLite 重建表）。

两个纪律：**邮件式「贡献 = 供给规范」**——贡献声明默认值与锁定项，实例由用户创建、
materializer 落地（领域行通过外键 `ON DELETE SET NULL` / 级联与实例行保持单一属主）；
**`directory` / `file` 字段值**——宿主只按字符串存储，存在性与安全校验是消费方
（适配器 / materializer）的责任（§2.3）。

## 附录：`plugin.*` 检查项速览

（`validate --json` 报告里 `checks[].id` 的全集；error 会让 `pack` 拒绝产出、exit code 1。）

**error**：

| 检查项 | 触发条件 |
|---|---|
| `plugin.manifest-read` | 包根没有 `plugin.json`、超过 64KB、JSON 语法错误 |
| `plugin.manifest-format` | `format_version` 高于支持的 `1` |
| `plugin.manifest-schema` | 清单不符合 §2 的 schema（消息带路径，一次最多显示 3 条 issue） |
| `plugin.usage` | 缺少必填的 `usage`（启用说明）：写清启用后还要做什么（启用即用 / 需要连接账号 / 需要先添加账号再勾选绑定） |
| `plugin.manifest-namespace` | `id` 用了保留命名空间 |
| `plugin.files-path` | 贡献路径缺失 / 类型不对 / 符号链接 / 逃逸插件目录 |
| `plugin.files-limits` | 超过条目 / 单文件 / 解包体积上限 |
| `plugin.package-entries` | zip 层问题（`..`、绝对路径、符号链接、大小写重名、加密、ZIP64） |
| `plugin.skill-frontmatter` | frontmatter 缺失 / 不闭合 / 缺 `name:` / `description:` |
| `plugin.connector-entry` | `server.json` 没过连接器检查，或没过安装器严格 schema（如缺 `releaseGate`） |
| `plugin.connector-packages` | 连接器条目带 `packages[]` |
| `plugin.connector-remote` | 端点非公网 https，或一个端点都没有 |
| `plugin.connector-icon` | 图标不在 `server.json` 同目录 |
| `plugin.mcpb-package` | `.mcpb` 不是合法 zip / 缺 manifest / 版本不支持 / 入口不在包内 |
| `plugin.mcp-http` | http 贡献 URL 非公网 https |
| `plugin.mail-host` | 邮件主机非公网域名 |
| `plugin.icon` | 未声明图标 / 声明了但文件缺失 / 溢出包目录 / 不是合法 SVG / PNG / 超过 256 KiB；超过 64 KiB 时另有市场化 warning |

**warn**（不拦打包，但应修掉）：`plugin.manifest-metadata`（缺 description / author /
homepage / engines）、`plugin.readme`（缺包根 README.md）、`plugin.icon`（图标超过 64 KiB 的
市场化上限，市场卡片会回落默认图标）、`plugin.field-default`（§2.3 的 default 用法问题）。

**info**（说明性）：`plugin.capabilities`（能力概述预览 + config / 实例计数）、
`plugin.permissions`（同意卡将展示的权限推导：主机 / OAuth 范围 / MCPB / 邮件）、
`plugin.icon`（图标已采纳）、`plugin.mcpb-package`（结构合法提示）、`plugin.mcp-http`
（公网 https 确认）。

---

`--json` 校验报告（`mode: "plugin"`、`schemaVersion: 1`）适合 CI；同一实现也是安装管线的
校验层。宿主侧开发的检查项锚点见
[packages/app-validator/README.md](../../packages/app-validator/README.md#plugin-packages)。
