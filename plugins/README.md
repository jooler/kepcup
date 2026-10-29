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
- **P5（2026-10-29）**：22 个插件全部重打包（18 个既有包 sha256 与线上索引逐字节一致——
  打包可复现性得到验证）并重签索引本地留档（`--verify` 通过）；4 个邮件插件 catalog
  定为 `verified`（主机锁定 + 文案已随 P3 审查）。索引自本批起携带由清单派生的
  `capabilitySummary`（签名脚本按 schema 解析后的清单生成——修复了 P4 引入的对省略空
  数组清单崩溃的问题）。**待维护者执行生产部署**：R2 上传全部 22 包 + 索引部署
  （`plugins/README.md` 上方流程第 5–6 步；直接署名会顶掉线上 18 条索引，部署前确认
  22 包已全部上传 R2）。
