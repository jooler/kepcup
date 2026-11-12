# KepCup 官方插件（marketplace 首批）

这里是 KepCup 官方插件的**开发目录**：每个子目录是一个独立插件源（`plugin.json` + 贡献），
用 `@kepcup/app-validator` 的 CLI 校验与打包，经 `infra/cloudflare/sign-plugins.sh` 签名后
发布到官方市场（`dl.kepcup.com/plugins/v1/`，包体在 R2 `kepcup-plugins` /
`pkg.kepcup.com`）。应用本身**不再随包内置**任何插件（D104 起转商店分发）。

## 目录约定

```
plugins/
  skill-<id>/          技能插件：skills/<id>/SKILL.md（+ requirements.txt）
  connector-<slug>/    连接器插件：connectors/<slug>/server.json（+ 图标）
  mail-<id>/           邮件插件（D105 P3）：instances: ['mail'] + 一份 mail 贡献
  im-<id>/             即时通讯插件（D107）：instances: ['im'] + 一份 im 贡献
  README.md
```

- 每个插件**必须有自己的图标**：`plugin.json` 的 `icon` 指向包内 `.svg` / `.png`
  （本地安装上限 256 KiB，**进入市场索引的图标必须 ≤64 KiB**）。技能 / 邮件插件放包根
  `icon.svg`；连接器插件直接指向 `connectors/<slug>/<slug>.svg`。市场卡片图标由签名
  脚本从包内读取并内联进索引（`summary.icon`），不发起远程图片请求；完全没图标时
  `validate` 报 error、签名告警，界面回落宿主默认图标（拼图），**不会**显示名称首字。
  详见 [docs/guides/write-a-plugin.md](../docs/guides/write-a-plugin.md) §2.4。

- 插件 id 用 `app.kepcup/<名>`：`com.kepcup` / `local.kepcup` 是保留命名空间，
  市场插件不得使用（`PLUGIN_RESERVED_NAMESPACES`）。
- 连接器目录通道（`dl.kepcup.com/connectors/v1`）已随商店化下线：连接能力完全由
  这里的市场插件承担；`server.json` 的 `_meta` 结构保持 registry 兼容形状。
- 技能展示字段（`displayName` / `icon` / `section` / `tryIt`）是内置插件专属，
  市场插件省略即可，界面回落到 SKILL.md 的 `name` / `description`。
- **邮件插件**：清单声明 `instances: ['mail']` 且恰好一份 `contributions.mail`
  （实例供给规范）。厂商插件锁定端点（imap/smtp host 非空，两侧成对声明），
  账号表单只有 地址 / 用户名 / 授权码（+ 插件 `instanceFields`）；通用插件
  （host 留空）的 IMAP/SMTP 端点变成必填实例字段，用户自填。
- **IM 插件**：清单声明 `instances: ['im']` 且恰好一份 `contributions.im`
  （transport / apiBase / setup / features，见设计 54）；账号由用户扫码或填表添加，
  再在 Bot 详情勾选绑定后才参与入站唤醒 / 出站转发。
- **MCP 插件凭据方案**：`contributions.mcp` 的 http 贡献可给 header 模板加
  `scheme`（当前仅 `"bearer"`）声明该 header 用裸凭据：宿主保存时 strip 用户自己粘的
  `Bearer `、发送时自动补前缀。未声明 `scheme` 的 header / 其他 MCP server 行为不变。
  字段语义与示例见 [docs/guides/write-a-plugin.md](../docs/guides/write-a-plugin.md) §3.3。
- **启用说明 `usage`（2026-11-03 起必填）**：一句话说明「启用之后还要做什么」
  （启用即用 / 需要连接账号 / 需要先添加账号再勾选绑定）。用户操作插件 30 秒后，
  宿主会把状态连同这句话发给 Bot，由它决定是否提醒用户补做遗漏步骤；详见
  [docs/guides/write-a-plugin.md](../docs/guides/write-a-plugin.md) §2.5 与设计 51 §15.8。
  依赖 `usage` 等新清单字段的插件必须把 `engines.kepcup` 抬到支持它的最低版本
  （当前 `>=0.5.7`），否则旧客户端会先看到可更新、下载后才解析失败。

## 开发流程（D104，docs/guides/write-a-plugin.md）

```bash
# 校验（目录）
node packages/app-validator/dist/cli.js validate plugins/skill-docx
# 打包（产物可复现；同时校验归档）
node packages/app-validator/dist/cli.js pack plugins/skill-docx --out /tmp/dist/skill-docx.kepcup
# 本地试装：扩展中心 → 已安装 → 从文件安装…
```

## 发布首批 / 增量发布

```bash
# 1. 打包全部插件到发布目录（清单必须带 usage；依赖新字段的插件 engines.kepcup 要抬高）
mkdir -p /tmp/market/packages && for d in plugins/*/; do
  n=$(basename "$d"); [ "$n" = "README.md" ] && continue
  node packages/app-validator/dist/cli.js pack "$d" --out "/tmp/market/packages/$n.kepcup"
done
# 2. 更新 catalog.json（tier 是策展元数据：verified / community）
# 3. 签名 + 产物（私钥读根 .env 的 KEPCUP_PLUGIN_SIGNING_KEY）
infra/cloudflare/sign-plugins.sh --out /tmp/market/dist --key-id kepcup-plugins-2026-1 \
  --packages /tmp/market/packages --catalog /tmp/market/catalog.json \
  --download-base https://pkg.kepcup.com
# 4. 本地验签，再上传 R2（--remote！）并部署索引（先拉回线上 connectors 产物，见 §0 ⚠️）
node scripts/sign-plugin-index.mjs --verify /tmp/market/dist --keys <(…登记的公钥…)
npx wrangler r2 object put "kepcup-plugins/<sha256>.kepcup" --remote --file "…" \
  --cache-control "public, max-age=31536000, immutable"
cd infra/cloudflare/directory && npx wrangler deploy
```

完整密钥 / 轮换 / 撤销说明见 [infra/cloudflare/plugins/README.md](../infra/cloudflare/plugins/README.md)。

## 批次清单

### 首批（18 个，2026-10-28 发布）

- 技能 9：docx / xlsx / pptx / pdf / mineru / meeting-notes / weekly-report /
  doc-coauthoring / internal-comms（原内置 `com.kepcup/starter-skills` 逐个拆分）；
- 连接器 9：notion / linear / atlassian / sentry / canva / stripe / cloudflare /
  gcalendar / gdrive（原内置 `com.kepcup/connections` 逐个拆分，server.json 未改）。

### D105 P3 追加（4 个邮件插件，2026-10-28 随插件平台 P3 开发；P5 打包 + 签名本地留档）

- 邮件 4：mail-generic（通用，自填 IMAP/SMTP）/ mail-163 / mail-126 / mail-qq
  （厂商，锁定端点）。实例型插件首批落地：一个插件可添加多个邮箱账号，
  添加入口在插件卡「管理」；卸载插件级联删除其全部账号、绑定与授权码。
- **2026-10-29 插件图标 + 商店补全（1.0.1）**：22 个插件全部补齐自有图标与 `engines`
  （4 个邮件插件补 README），重新校验为零 error / 零 warning；全部重打包为 `1.0.1`
  并重新签名，R2 上传 22 个包 + 索引部署到 `dl.kepcup.com/plugins/v1/`。线上索引由
  18 条（1.0.0）变为 22 条（1.0.1），四个邮件插件正式进入市场。线上索引验签与
  22 个包的 sha256 / 大小逐一复核通过。

- **2026-10-29 市场卡片图标**：签名脚本现在从每个包内读取 `icon` 并内联到索引条目
  `summary.icon`（原始图标 ≤64 KiB），市场卡片直接显示插件自有图标，缺失时回落宿主
  默认图标。**已重新签名并部署**：22 个包重新打包后 sha256 / 大小与线上 1.0.1 完全一致
  （R2 内容寻址对象无需重传），新索引 `generatedAt=2026-10-29T09:15:19.816Z`、
  22/22 带图标，线上拉回验签通过。

- **2026-11-03 微信插件上架（im-wechat 1.0.0）**：v0.5.6 的宿主发布不带市场条目，
  本次补上（见 `im-wechat/README.md` §9 的发布门槛：`engines.kepcup >=0.5.5`）。
  `catalog.json` 新增 `im-wechat.kepcup`（tier `verified`，categories 由签名脚本从
  `contributions.im` 推导，`sign-plugin-index.mjs` 的 `categoriesOf` 同步补上 `im` 分支；
  全部 23 包重新打包，既有 22 包 sha256 与线上 1.0.1 逐字节一致、R2 无需重传，im-wechat
  上传为 `6b1a3ed4…kepcup`）。新索引 `generatedAt=2026-11-03T06:13:20.869Z`（严格递增）、
  23 条，生产密钥 `kepcup-plugins-2026-1` 签名；R2 上传后 `wrangler deploy` 上线，线上
  索引拉回验签通过、微信包从 `pkg.kepcup.com` 下载回本地 sha256 复核一致。

- **2026-11-03 启用说明 + 全部升版 1.1.0**：`plugin.json` 新增必填字段 `usage`
  （启用说明，设计 51 §15.8）。23 个官方插件逐个补齐并统一升版 `1.1.0`：技能 / 连接 /
  邮件 / 微信各自写明「启用即用」或「需要连接 / 添加账号再勾选绑定」的完整步骤。
  23 个包重新打包 → 生产密钥 `kepcup-plugins-2026-1` 签名（新索引
  `generatedAt=2026-11-03T06:57:19.231Z`，严格递增、23 条）→ 全部包上传 R2（内容寻址，
  新增 23 个 sha256 对象）→ `wrangler deploy` 上线（Worker version
  `707bb25b-a8d2-49bc-a425-b402d502b381`）。线上索引与 23 个包拉回 `--verify` 通过。

- **2026-11-03 修正发布（engines 抬到 >=0.5.7）**：独立审查发现 `usage` 是 strict schema
  的新字段，旧宿主（<0.5.7）会拒绝解析；若 `engines` 仍写 `>=0.4.0`，旧客户端会先看到
  「可更新」再下载失败。23 个插件统一把 `engines.kepcup` 抬到 `>=0.5.7`（微信 / 邮件 / 技能
  同一门槛），按同一流程重新打包 + 签名 + 上传 + 部署：新索引
  `generatedAt=2026-11-03T09:28:38.920Z`（严格递增、23 条、全部 `1.1.0`），Worker version
  `1482ed01-0ec3-4990-8889-7f8145c20d43`；线上索引与 23 个包拉回 `--verify` 通过。旧客户端
  现在会在索引层过滤掉 1.1.0，升级宿主后再更新。

### 在线文档平台批次（3 个，2026-11-12 开发；待签名发布）

- 工具 3：`mcp-tencent-docs`（腾讯文档，厂商模版：锁定官方 MCP 端点 + `Authorization`
  token）/ `mcp-feishu`（飞书，通用模版：`url:''`，粘贴个人 MCP 服务地址，`urlSensitive`）/
  `mcp-yuque`（语雀，内嵌官方 `yuque-mcp` 的 MCPB，token + host 走安装表单）。
- 依赖 P4-M2 的 mcp 实例化（设计 51 §15.7 实施注），`engines.kepcup` 抬到 `>=0.5.11`；
  未发布前用户可经「从文件夹安装」试用。语雀包先跑 `node plugins/mcp-yuque/build.mjs`
  生成 `mcp/yuque.mcpb` 再 validate / pack。
