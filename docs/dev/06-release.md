# 发行与更新

KepCup 怎么打包、发布到哪些渠道、用户怎么收到更新，以及每次发版要做什么。打包配置本身（产物剔除、原生模块、平台资源）见 [phases/P13-release.md](phases/P13-release.md) 与 `apps/desktop/electron-builder.yml` 的注释。

## 一览

| 平台 | 渠道 | 构建与发布 | 用户怎么更新 |
|---|---|---|---|
| macOS（arm64 / x64） | GitHub Releases：dmg（首次安装）+ zip（更新用） | 推 main 后 CI 自动构建、签名、公证、发布 | 应用内自动更新（electron-updater） |
| Windows（x64 / arm64） | GitHub Releases：一个合并 NSIS 安装包 | 推 main 后 CI 自动构建、发布 | 应用内自动更新 |
| Windows | Microsoft Store：MSIX（x64，arm64 机器走仿真） | CI 构建 MSIX，本地跑 `store-upload.mjs` 提交 | 商店更新，应用内更新关闭 |
| Linux（x64 / arm64） | GitHub Releases：AppImage + deb | 推 main 后 CI 自动构建、发布 | AppImage 应用内静默更新；deb 应用内更新（会弹 pkexec 要密码） |
| Linux x64 / arm64（headless 服务端） | GitHub Releases：`kepcup-server-v{v}-{platform}-{arch}.tar.gz`（`npm i -g <url>` 或解压 `./dist/cli.js` 直跑） | release.yml 的 `server` job（pack + 干净解压冒烟）随桌面版一起发；部署见 `apps/server/README.md` | 暂无自动更新：重新下载安装（数据目录不受影响） |

**不做的渠道：**

- **Mac App Store**：上架必须开 App Sandbox，子进程会继承应用的沙箱，用户机器上的 CLI（git、claude、brew 装的工具）读不到家目录和 `/opt/homebrew`；KepCup 自己的命令沙箱用的 `sandbox-exec` 在 App Sandbox 里也用不了。另外审核指南 2.5.2 禁止执行会改变功能的代码。核心能力无法保留，所以不做 Mac App Store。Developer ID 签名 + 公证同样没有「未知开发者」警告，你的 Apple 开发者身份用在这里。
- **Flathub**：见 [Linux 与 Flathub](#linux-与-flathub)。

## 分支与版本

- `main`：只接收「要发布的东西」。每次推送都会跑 CI（`.github/workflows/ci.yml`）和发行流水线（`.github/workflows/release.yml`）。
- 版本分支 `release/X.Y`：日常开发在这里。满意后改版本号，合并进 main 并推送。
- 版本号只有一个来源：`apps/desktop/package.json` 的 `version`（electron-builder 只读这里，根 `package.json` 的版本不用管）。
- **是否发版由版本号决定，而不是由推送决定。** release.yml 的 prepare job 读版本号：tag `vX.Y.Z` 不存在就构建并发布，已存在就跳过。所以：
  - 推 main 时忘了改版本号 → 什么都不发布（Actions 的运行摘要里写明「已发布，跳过」）。
  - `0.0.0`（当前占位）和预发布版本（`1.0.0-beta.1`）永不发布。先从 `0.1.0` 开始。
  - 不用手动打 tag：发布时 CI 用 `gh release create` 在被构建的那个提交上建 tag。
- 修复（hotfix）：在当前版本分支修，`prepare.mjs patch` 升补丁号，同样合并推送。

## 发一个版本

```bash
# 1. 在版本分支上
git switch release/0.2
node scripts/release/prepare.mjs minor        # 或 patch / major / 0.2.0
#    → 改 apps/desktop/package.json 版本号（tag 已存在会拒绝）
#    → 生成 docs/releases/v0.2.0.md 草稿（提交记录列表），改写成用户能看懂的说明
git add -A && git commit -m "release: v0.2.0"

# 2. 合并进 main 并推送
git switch main && git merge --no-ff release/0.2 && git push origin main
#    → GitHub Actions：release.yml 构建 5 个平台 job（约 30–60 分钟，macOS 公证占大头）
#    → 全部成功后：草稿 Release 上传所有文件 → 转为正式 → 已安装的用户开始收到更新

# 3. Release 发布后，本地提交 Microsoft Store
node scripts/release/store-upload.mjs 0.2.0   # 可加 --draft 先只上传不提交审核
```

`docs/releases/vX.Y.Z.md` 是 GitHub Release 的正文；没有这个文件时用 GitHub 自动生成的说明。

任一平台构建失败时整个版本都不发布（publish job 依赖全部 build job）。修好后再推一次 main，或在 Actions 页手动重跑 release 工作流（workflow_dispatch）。tag 还没建，所以版本号不用改。

## 一次性准备

按顺序做。全部凭据都填在 `.env.release` 一个文件里：

```bash
cp .env.release.example .env.release && chmod 600 .env.release
# 逐项填写（文件内有每一项的取得路径）
node scripts/release/sync-github-secrets.mjs --dry-run   # 看会同步哪些
node scripts/release/sync-github-secrets.mjs             # 写入 GitHub Actions 机密/变量
```

同步脚本只写非空项，从不删除；证书和密钥文件按路径读取，base64 后经 stdin 交给 `gh`，不出现在命令行参数里。

### 1. GitHub

- 仓库 `jooler/kepcup` 保持**公开**：用户端 electron-updater 匿名读 Releases，私有仓库收不到更新。
- 本机装 [GitHub CLI](https://cli.github.com/) 并 `gh auth login`（同步脚本、商店上传脚本都用它）。
- 工作流用自带的 `GITHUB_TOKEN`（`contents: write`），不需要额外的 token。
- 可选：给 `main` 开分支保护，要求 CI 通过才能合并（release.yml 本身不等 CI 结果）。

### 2. Apple（macOS 签名与公证）

1. [developer.apple.com](https://developer.apple.com/account/resources/certificates/list) → Certificates → 新建 **Developer ID Application** 证书（不是 Apple Development / Apple Distribution）。用 Mac 的钥匙串生成 CSR，下载证书后双击装进钥匙串，再在「我的证书」里右键导出为 `.p12`（要含私钥），设一个密码。→ `MAC_CSC_P12_PATH`、`MAC_CSC_KEY_PASSWORD`
2. [App Store Connect](https://appstoreconnect.apple.com/access/integrations/api) → 用户和访问 → 集成 → App Store Connect API → 团队密钥，新建一个（角色「开发者」即可），下载 `.p8`（只能下载一次）。→ `APPLE_API_KEY_P8_PATH`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`

没配 `MAC_CSC_LINK` 时 macOS job 仍会出包，但会打出警告：未签名的包会被 Gatekeeper 拦截，而且 macOS 的自动更新要求应用已签名，所以这样的版本不应该发布。

签名与公证的接线：`electron-builder.yml` 的 `mac` 段开 hardened runtime，配 `resources/entitlements.mac.plist`（JIT、原生模块、麦克风、摄像头）；有 `CSC_LINK` 时签名，签名成功后检测到 `APPLE_API_KEY*` 三件套就公证。electron-builder 26 的 `APPLE_API_KEY` 要求是 `.p8` 的**文件路径**，所以 CI 把机密 `APPLE_API_KEY_BASE64` 解码成临时文件再传路径。

### 3. Microsoft Store

1. Partner Center 里新建应用、保留名称「KepCup」，在「产品管理 → 产品标识」页复制三项 → `MSSTORE_IDENTITY_NAME`、`MSSTORE_PUBLISHER`、`MSSTORE_PUBLISHER_DISPLAY_NAME`，跑一次同步脚本（写成仓库变量）。之后每次发版，CI 的 Windows job 都会额外产出 MSIX（workflow 工件 `store-msix`，保留 90 天）。
2. **首次提交手工做**：发出第一个版本后跑 `node scripts/release/store-upload.mjs X.Y.Z --download-only`，MSIX 会下载到 `apps/desktop/release/store/vX.Y.Z/`。在 Partner Center 新建提交，上传这个包，填好商店信息、年龄分级、隐私政策 URL 并提交审核。商店 API 只能更新已经上线的应用。
3. 开通提交 API（供后续 `store-upload.mjs` 使用）：
   - 账户设置 → 租户：关联一个 Microsoft Entra ID 租户（可以在页面里免费新建）。
   - 用户管理 → Microsoft Entra 应用程序：添加应用，角色选 **Manager**，生成客户端密钥。
   - 把租户 ID、卖家 ID、客户端 ID、客户端密钥、商店产品 ID 填进 `.env.release` 的「本地」段。
   - ⚠️ 官方文档没有明确说个人开发者账户也能关联租户。如果你的账户设置里没有「租户」「用户管理」入口，就只能在 Partner Center 手工上传包；`--download-only` 仍然能帮你取包。
4. 本机安装 [Microsoft Store Developer CLI](https://github.com/microsoft/msstore-cli)（`msstore`，Windows/macOS/Linux 都支持，需要 .NET 运行时）。

MSIX 不需要代码签名证书：提交时可以不签名，商店会重签。商店版里应用内更新是关闭的（`apps/desktop/src/main/updater.ts` 检测到 `process.windowsStore` 后不检查更新源），由商店负责更新。

### 4. Windows 签名（可选，可以以后再做）

只影响 GitHub 直接下载的 NSIS 安装包。不签名时，首次运行会出现 SmartScreen「Windows 已保护你的电脑」，用户要点「更多信息 → 仍要运行」；商店版不受影响。个人开发者可选：

| 方案 | 成本 | 限制 |
|---|---|---|
| 不签名，引导用户优先用商店版 | 0 | 直接下载的版本有 SmartScreen 提示 |
| [SignPath Foundation](https://signpath.org/)（开源免费） | 0 | 要求 OSI 许可证（GPL-3.0 可以）、全部在 GitHub 托管 runner 上从源码构建、每次签名人工批准、主页上要有代码签名政策；对新项目有「可验证声誉」门槛，可能被拒；证书署名是 SignPath Foundation |
| [Certum 开源代码签名证书](https://shop.certum.eu/open-source-code-signing-on-simplysign.html) | 云版约 €49/年 | 署名「Open Source Developer 你的姓名」，要个人证件；云签名（SimplySign）需要手机动态码，CI 里无人值守只能靠社区方案 |
| Azure Artifact Signing（原 Trusted Signing） | — | 个人开发者只限美国、加拿大，中国大陆不可用 |

拿到 `.pfx` 证书后填 `WIN_CSC_P12_PATH`、`WIN_CSC_KEY_PASSWORD` 并同步即可，工作流已经接好。

## 流水线做了什么

`.github/workflows/release.yml`：

1. **prepare**：读版本号，判定是否发布（见上文）。
2. **rootfs**：构建 Windows 包里的 WSL rootfs（P12/P13）——x64 + arm64 双架构（arm64 走 `docker/setup-qemu-action`），产物按架构落 `apps/desktop/resources/wsl/{x64,arm64}/`，由 win build job 经 artifact 消费；electron-builder `from: resources/wsl/${arch}` 保证合并 NSIS 的每个架构负载只带匹配的 rootfs。本地 `pnpm dist --win` 缺产物时默认自建（`scripts/dist.mjs` 步骤 0；`KEPCUP_DIST_SKIP_ROOTFS=1` 跳过）。
3. **build**（5 个 job，统一 `--publish never`，只出文件）：
   - `macos-latest`（arm64）和 `macos-15-intel`（x64）：dmg + zip，签名 + 公证。
   - `windows-latest`：`--x64 --arm64` 在同一次构建里出合并的 NSIS 安装包和唯一的 `latest.yml`（分开构建的话，两个 `latest.yml` 会互相覆盖）。配了商店变量时再单独构建一次 x64 MSIX：不签名（用 Windows 证书签会因为发布者和商店身份不符而失败），输出到 `release-store/`。
   - 每个 job 都写全目标（如 `--mac dmg zip --arm64`）：只给架构时 electron-builder 会沿用配置里的 arch 列表，两个架构都构建。
   - `ubuntu-24.04` / `ubuntu-24.04-arm`：AppImage + deb。
4. **publish**：同名文件出现在两个 job 的产物里时直接失败。两个 macOS job 各写了一份 `latest-mac.yml`，用 `scripts/release/merge-update-manifests.mjs` 合并成一份（electron-updater 按文件名里有没有 `arm64` 选架构）。确认 4 份更新清单齐全后，建草稿 Release、上传全部文件，再转为正式版并标记为 latest。上次中途失败留下的同名草稿会先删掉。

上传到 Release 的文件：

| 文件 | 用途 |
|---|---|
| `latest.yml`、`latest-mac.yml`、`latest-linux.yml`、`latest-linux-arm64.yml` | electron-updater 的更新清单 |
| `*.exe`、`*-mac.zip`、`*.AppImage`、`*.deb` 及各自的 `.blockmap` | 安装与增量更新 |
| `*.dmg` | macOS 首次安装 |

## 各渠道的更新方式

- **GitHub 渠道**（dmg/zip、NSIS、AppImage、deb）：electron-updater 读 `electron-builder.yml` 里 `publish` 写入的 `app-update.yml`（`jooler/kepcup`），启动后延迟检查、之后定时检查，后台下载；有执行在进行时由 update-gate 等它结束或请用户确认后再重启安装（P13 任务 2）。`KEPCUP_UPDATE_URL` 环境变量可以在运行时改成任意 generic HTTPS 源。
- **商店 / Flatpak 渠道**：`externalUpdateChannel()` 检测到 `process.windowsStore`、`process.mas` 或 `FLATPAK_ID` 时不配置更新源、不检查，更新状态一直是 idle。

## 更新镜像与选源（R2 + OSS）

GitHub Releases 是唯一写入口；publish job 在转正式后把 Release 资产同步成两个只读副本（`scripts/release/sync-mirrors.mjs`）：**R2**（`updates.kepcup.com`，国际第二源，流出免费）与**阿里云 OSS**（bucket 默认域名即可用、无需备案，国内首选）。OSS bucket 必须开**公共读**；账号若开启了「阻止公共访问」（Block Public Access），bucket 级和对象级的公共 ACL 都会被拦（报 `Put public bucket acl is not allowed`），需先在 OSS 控制台「权限控制」里关闭再设公共读。同步失败不阻塞发布（GitHub 渠道已就绪），step summary 里会留警告，本地 `node scripts/release/sync-mirrors.mjs <tag>` 幂等重跑即可。凭据在 `.env.release`「CI · 更新镜像」段，经 `sync-github-secrets.mjs` 同步为 GitHub 机密；全空时该步骤自动跳过。

三条自洽保障：

1. **顺序红线**：安装包与 blockmap 先传、`latest*.yml` 最后传——镜像上的清单永远不会指向缺失文件，半同步状态表现为「探测失败」（客户端落回别的源）而不是让用户下到坏包。
2. **内容校验**：每个对象 PUT 后 HEAD 回读比大小，清单再逐字节比对并校验 `version:` 等于本次 tag。
3. **完整性兜底**：`latest.yml` 里的 sha512 由客户端校验，镜像内容本身不被信任；写权限只给 CI（R2 限定 scope 的 API 令牌、OSS 只能写该 bucket 的 RAM 子账号）。

客户端不按地理位置硬切，按**实际可达性**选源（`apps/desktop/src/main/update-sources.ts`）：每次选源按优先级（github → r2 → oss）发轻量探测（GitHub 打 `api.github.com/rate_limit` 免费端点，镜像直接拉 `latest.yml`，各 4 秒超时），第一个可用者胜出并持久化到 `<userData>/update-source.json`，之后检查直达不再探测；失败一次才重新探测并排除坏源。国内用户自然落到 OSS，能直连 GitHub 的用户零开销。`KEPCUP_UPDATE_MIRRORS`（逗号分隔 generic 基 URL，首位 r2 次位 oss）整体替换烘焙镜像，本地调选源逻辑用；`KEPCUP_UPDATE_URL` 仍是最高优先级的整源覆盖。main 进程日志已接 `autoUpdater.logger`，差量下载的块数/字节数看 `[updater]` 前缀日志。

## Linux 与 Flathub

原设想是「推 main 后 Flathub 自动构建并更新」。这条路目前走不通，原因按严重程度排列：

1. **生成式 AI 政策（2026-01）**：Flathub 要求在应用里披露 AI 生成的代码；清单（manifest）不能含 AI 生成或辅助的内容；提交 PR、提交说明、回复都不能由 AI 工具完成。最关键的一条：只要软件或申请里有 LLM 参与的迹象，就**不批**沙箱逃逸类例外（`--filesystem=home`/`host`、`flatpak-spawn --host`）。KepCup 大量代码由 AI 编写，而它又离不开这些例外。
2. **必须从源码构建（2026-02 起）**：开源应用不能再重新打包 GitHub Release 里的二进制。需要在 flatpak-builder 里离线构建 pnpm monorepo 和三个原生模块（better-sqlite3-multiple-ciphers、@napi-rs/keyring、es-git）。
3. **沙箱冲突**：Flatpak 的 seccomp 禁止建新的用户命名空间，KepCup 在 Linux 上用的 bubblewrap 沙箱（srt）在 Flatpak 里跑不起来；执行用户机器上的工具也要走 `flatpak-spawn --host`，需要改执行层代码。
4. **更新节奏不是「推送触发」**：Flathub 靠 external-data-checker 定时检查上游 Release，一个仓库大约每 24 小时轮到一次，然后开 PR、构建、合并；自动合并（`automerge-flathubbot-prs`）还要申请 linter 例外，只批给已验证的应用。

结论：Linux 走 GitHub Releases 的 AppImage + deb，它们都有应用内自动更新，体验上已经覆盖「推送即更新」。仍然想上 Linux 应用商店的话，可以评估 Snap Store：经典约束（classic confinement）可以访问宿主，适合开发工具类应用，但需要人工审核，也要先确认其政策；electron-builder 有 `snap` 目标。这件事等有明确需求时再单独立项。

## 待补充

发版前需要确认或补齐的事项：

- [ ] **首跑验证**：第一次发版（建议 `0.1.0`）时观察 release.yml 全流程。重点看：Windows 在 x64 runner 上交叉编译 arm64 原生模块；`-c.appx.*` 覆盖项生效；`macos-15-intel` 上原生模块重编译；合并后的 `latest-mac.yml` 在 Intel 和 Apple Silicon 两种 Mac 上都能更新。
  - 已修：`scripts/dist.mjs` 用 `process.execPath` 直接跑 `electron-vite` / `electron-builder` CLI（避免 Windows 上 `spawnSync('pnpm')` 找不到 `pnpm.cmd`）；Linux `executableName: KepCup`（避免 AppImage 因 `@kepcup/desktop` 含 `@` 失败）。
- [ ] **自动更新端到端**：装 `0.1.0` → 发 `0.1.1` → 三平台确认能收到更新并安装（[todo/cross-platform-acceptance.md](../../todo/cross-platform-acceptance.md) P13「自动更新端到端」）。
- [ ] **商店版开机自启**：MSIX 里 `app.setLoginItemSettings` 不生效，需要在清单里声明 StartupTask（electron-builder `appx.customExtensionsPath`），运行时改用 StartupTask API。在此之前，商店版设置页的「开机自启」开关不起作用。
- [ ] **商店版更新界面**：应用内更新关闭后状态一直是 idle，点「检查更新」会显示「已是最新」，容易误导。商店/Flatpak 版应该显示「由 Microsoft Store 更新」。
- [x] **Windows arm64 的 WSL rootfs**（2026-10-18 双架构接线解决）：rootfs job 现产 `resources/wsl/{x64,arm64}/` 双目录（arm64 容器跑在 qemu 上，`--platform` 与目标架构一一对应），electron-builder 按 `${arch}` 子目录取件；arm64 安装包不再带 x64 rootfs。**arm64 WSL2 真机自检仍留验证**——见 [todo/cross-platform-acceptance.md](../../todo/cross-platform-acceptance.md) P12。
- [ ] **品牌信息统一**：`apps/desktop/package.json` 的 `homepage`/`author.email` 用的是 `kepcup.app`，官方域名是 `kepcup.com`。商店和 Linux 包的元数据都会显示这些值。
- [ ] **隐私政策 URL**：Microsoft Store 提交要求提供（应用会访问网络、调用用户配置的模型服务）。
- [ ] 可选：winget（`wingetcreate` / Komac 可以在 CI 里自动给 winget-pkgs 提 PR）、Homebrew Cask。两者都会自动跟踪 GitHub Release 的新版本。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 推了 main 但没有发布 | 看 release 工作流 prepare job 的运行摘要：版本号没改（tag 已存在）、仍是 `0.0.0`，或带了预发布后缀 |
| macOS job 报 notarization 需要 3 个变量 | `APPLE_API_KEY_P8_PATH`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` 只填了一部分。同步脚本会拦截这种情况，但 GitHub 网页上手改机密时不会 |
| 公证失败 `The signature of the binary is invalid` | 证书类型不对（必须是 Developer ID Application），或 `.p12` 导出时没带私钥 |
| publish job 报 `expected 2 latest-mac.yml` | 某个 macOS job 没产出更新清单。看该 job 日志，通常是签名失败 |
| `store-upload.mjs` 报 no successful release.yml run 或下载失败 | 该 tag 对应提交的 release 工作流没成功，或 `store-msix` 工件已过期（90 天）。重跑工作流会因为 tag 已存在而跳过，所以过期的版本只能随下一个版本一起上商店；发版后尽快提交 |
| `msstore` 鉴权失败 | 客户端密钥过期，到 Partner Center 重新生成后更新 `.env.release` |
