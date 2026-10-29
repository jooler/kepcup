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
# 1. 打包全部插件到发布目录
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
