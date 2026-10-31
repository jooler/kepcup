# 发行与更新

KepCup 怎么打包、发布到哪些渠道、用户怎么收到更新，以及每次发版要做什么。打包配置本身（产物剔除、原生模块、平台资源）见 [phases/P13-release.md](phases/P13-release.md) 与 `apps/desktop/electron-builder.yml` 的注释。

## 一览

| 平台 | 渠道 | 构建与发布 | 用户怎么更新 |
|---|---|---|---|
| macOS（arm64 / x64） | GitHub Releases：dmg（首次安装）+ zip（更新用） | 推 main 后 CI 自动构建、签名、公证、发布 | 应用内自动更新（electron-updater） |
| Windows（x64 / arm64） | GitHub Releases：一个合并 NSIS 安装包 | 推 main 后 CI 自动构建、发布 | 应用内自动更新 |
| Windows | Microsoft Store：MSIX（x64，arm64 机器走仿真） | CI 构建 MSIX，本地跑 `store-upload.mjs` 提交 | 商店更新，应用内更新关闭 |
| Linux（x64 / arm64） | GitHub Releases：AppImage + deb | 推 main 后 CI 自动构建、发布 | AppImage 应用内静默更新；deb 应用内更新（会弹 pkexec 要密码） |
| Linux RHEL 9 / 10（x86_64 / aarch64） | GitHub Releases：rpm（`kepcup-<version>.x86_64.rpm`，AlmaLinux 9 基线） | 推 main 后 CI 在 AlmaLinux 9 容器里构建，再分别在 RHEL 9/10 容器安装冒烟 | 应用内更新（electron-updater 按 rpm 安装类型更新；会弹 pkexec 要密码） |
| Linux Flatpak（x64 / arm64） | GitHub Releases：`.flatpak` bundle（freedesktop 26.08 运行时） | 推 main 后 CI 构建；不上 Flathub（见下文） | 由 Flatpak 渠道更新（重新安装新 bundle）；应用内更新关闭 |
| Linux Snap（x64 / arm64） | GitHub Releases：`.snap`（core24，classic） | 推 main 后 CI 用 snapcraft 构建；不自动上架 Snap Store | 由 snapd 更新（`snap refresh`）；应用内更新关闭 |
| Linux x64 / arm64（headless 服务端） | GitHub Releases：`kepcup-server-v{v}-{platform}-{arch}.tar.gz`（`npm i -g <url>` 或解压 `./dist/cli.js` 直跑） | release.yml 的 `server` job（pack + 干净解压冒烟）随桌面版一起发；部署见 `apps/server/README.md` | 暂无自动更新：重新下载安装（数据目录不受影响） |

**不做的渠道：**

- **Mac App Store**：上架必须开 App Sandbox，子进程会继承应用的沙箱，用户机器上的 CLI（git、claude、brew 装的工具）读不到家目录和 `/opt/homebrew`；KepCup 自己的命令沙箱用的 `sandbox-exec` 在 App Sandbox 里也用不了。另外审核指南 2.5.2 禁止执行会改变功能的代码。核心能力无法保留，所以不做 Mac App Store。Developer ID 签名 + 公证同样没有「未知开发者」警告，你的 Apple 开发者身份用在这里。
- **Flathub**：不上架（原因见 [Linux 与 Flathub](#linux-与-flathub)），但 CI 会构建自托管的 `.flatpak` bundle，作为 GitHub Release 资产分发。

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
4. **linux-rpm**（2 个 job：x86_64 / aarch64）：在 `almalinux:9` 容器里 `pnpm install` + `pnpm -r build` + `dist.mjs --linux rpm`，而不是在 Ubuntu 上交叉打包。选 RHEL 9 作基线是因为 glibc 向后兼容（RHEL 10 能跑 2.34 构建的二进制），一份 rpm 同时支持 RHEL 9/10；同时避免 Ubuntu 24.04 的 glibc 2.39 污染原生模块（RHEL 9 加载时报 missing symbol）。构建容器里还要 `dnf install` 与 `rpm.depends` 相同的 Electron 运行时库（`nss` 等）：`afterPack` 会用打包后的二进制做组件查询冒烟，最小镜像里没有 `libnspr4.so`。另外要装 `libxcrypt-compat`（`libcrypt.so.1`）：electron-builder 自带的 fpm Ruby 在 AlmaLinux 9 上缺这个库，冒烟通过后打包会失败。
   - `es-git@0.7.0` 的官方 gnu 预编译绑定引用 glibc 2.38 才有的 `__isoc23_strtol`，RHEL 9 上 Node 加载即失败（core 启动就 import es-git）。所以构建前跑 `scripts/release/rebuild-es-git.sh`，从同一 tag 源码重建。
   - rpm job 产出的 `latest-linux*.yml` 里有 rpm 的 sha512/size；publish 会把它和 AppImage/deb 的清单合并，rpm 安装才能走应用内更新。
5. **linux-rpm-verify**（4 个 job：RHEL 9/10 × x86_64/aarch64）：下载 rpm 后在对应发行版容器里 `dnf install`，再对 `/opt/KepCup/KepCup` 跑 `ldd` 确认没有 missing shared library。rpm 的 AutoReq 被 fpm 关闭，只校验我们显式声明的 `depends`，所以必须真装一遍。
6. **linux-flatpak**（x64 / arm64）：Ubuntu runner 上安装 `flatpak` + `flatpak-builder`，从 Flathub 拉 freedesktop `26.08` runtime/sdk 和 `org.electronjs.Electron2.BaseApp`，由 electron-builder 的 `flatpak` target 打 `.flatpak` bundle；构建后用 `flatpak build-import-bundle` 导入一遍验证结构。
7. **linux-snap**（x64 / arm64）：Ubuntu runner 上 `snap install snapcraft --classic --channel=8.x/stable`（不要装 latest：snapcraft 9.1+ 的 GUI 中介回归会让 `meta/gui/*.desktop` 在 prime 时找不到，见 [canonical/snapcraft#6519](https://github.com/canonical/snapcraft/issues/6519)），electron-builder 生成 `snapcraft.yaml`（core24、classic）并以 `--destructive-mode` 构建（不需要 LXD/Multipass）；构建后用 `unsquashfs -l` 校验 `meta/snap.yaml` 与应用入口。
8. **publish**：同名文件出现在两个 job 的产物里时直接失败。两个 macOS job 各写了一份 `latest-mac.yml`，用 `scripts/release/merge-update-manifests.mjs` 合并成一份（electron-updater 按文件名里有没有 `arm64` 选架构）；Linux 每个架构的 AppImage/deb 与 rpm 清单同样合并。确认 4 份更新清单齐全后，建草稿 Release、上传全部文件，再转为正式版并标记为 latest。上次中途失败留下的同名草稿会先删掉。

上传到 Release 的文件：

| 文件 | 用途 |
|---|---|
| `latest.yml`、`latest-mac.yml`、`latest-linux.yml`、`latest-linux-arm64.yml` | electron-updater 的更新清单 |
| `*.exe`、`*-mac.zip`、`*.AppImage`、`*.deb`、`*.rpm` 及各自的 `.blockmap` | 安装与增量更新 |
| `*.dmg` | macOS 首次安装 |
| `*.flatpak`、`*.snap` | Linux 渠道包（手动安装；无应用内更新） |

## 各渠道的更新方式

- **GitHub 渠道**（dmg/zip、NSIS、AppImage、deb、rpm）：electron-updater 读 `electron-builder.yml` 里 `publish` 写入的 `app-update.yml`（`jooler/kepcup`），启动后延迟检查、之后定时检查，后台下载；有执行在进行时由 update-gate 等它结束或请用户确认后再重启安装（P13 任务 2）。`KEPCUP_UPDATE_URL` 环境变量可以在运行时改成任意 generic HTTPS 源。
- **商店 / Flatpak / Snap 渠道**：`externalUpdateChannel()` 检测到 `process.windowsStore`、`process.mas`、`FLATPAK_ID` 或 `SNAP_NAME` 时不配置更新源、不检查，更新状态一直是 idle。Flatpak / Snap 的只读挂载无法被 electron-updater 替换，更新由对应渠道负责。

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

结论：**不上 Flathub**，但 CI 会构建自托管的 `.flatpak` bundle（GitHub Release 资产）；Linux 同时还出 RPM 与 Snap，见下节。

## Linux 渠道包（RPM / Flatpak / Snap）

三类包都在 release.yml 里随版本构建。RPM 与 AppImage/deb 一样走 electron-updater（见 `latest-linux.yml`）；Flatpak/Snap 是只读安装，无法应用内替换，更新由对应渠道负责。

**RPM（RHEL 9 / RHEL 10）**

- 在 `almalinux:9` 容器里从源码构建，一份 rpm 同时支持 RHEL 9 与 RHEL 10（glibc 向后兼容），覆盖 x86_64 与 aarch64。不要在 Ubuntu runner 上出 rpm：Ubuntu 24.04 的 glibc 2.39 会让 `npmRebuild` 产出的原生模块依赖 RHEL 9（2.34）没有的符号。构建容器要装上 `electron-builder.yml` 里 `rpm.depends` 的同一组包（AlmaLinux 9 包名），否则 `afterPack` 冒烟加载 Electron 时会缺 `libnspr4.so`。这些包仍然是安装时的 `Requires`，`linux-rpm-verify` 的 `ldd` 检查不变。同一条 `dnf install` 还要带 `libxcrypt-compat`，给 electron-builder 自带的 fpm Ruby 提供 `libcrypt.so.1`。
- `es-git@0.7.0` 的 gnu 预编译绑定引用 `__isoc23_strtol`（glibc 2.38），RHEL 9 上 Node 一加载就失败。构建前用 `scripts/release/rebuild-es-git.sh` 从同一 tag 源码重建；升级 `es-git` 时脚本会自动跟随 `packages/core/package.json` 的版本。若上游源码构建不再可用，CI 会直接失败，不会静默发布一个起不来的包。
- 安装：`sudo dnf install ./kepcup-<version>.x86_64.rpm`（aarch64 文件名对应 `aarch64`）。安装后应用内更新会按 rpm 类型走 electron-updater（与 deb 一样会弹 pkexec 要密码）。CI 的 `linux-rpm-verify` 会在 RHEL 9 和 RHEL 10 容器里各装一次并检查 `ldd`。

**Flatpak（freedesktop 26.08）**

- `.flatpak` bundle 由 electron-builder 的 `flatpak` target 产出，runtime/sdk 用当前最新的 freedesktop 26.08，`org.electronjs.Electron2.BaseApp//26.08`；Fedora 43+ 及更老版本都能安装（runtime 与宿主发行版解耦）。
- 安装：`flatpak install --user ./kepcup-<version>-x86_64.flatpak`，运行 `flatpak run app.kepcup.desktop`。finish-args 给了 `home`、网络、摄像头/麦克风（`--device=all`）与 `org.freedesktop.Flatpak`（供 `flatpak-spawn --host`）。
- **已知限制**：Flatpak 的 seccomp 禁止创建用户命名空间，KepCup 在 Linux 上的 bubblewrap/srt 命令沙箱在 Flatpak 内跑不起来；执行宿主工具也需要执行层改用 `flatpak-spawn --host`（当前没改）。这两项属于产品适配，不是打包问题。

**Snap（core24，classic）**

- CI 在 Ubuntu 24.04 runner 上用 snapcraft 8.x（`--channel=8.x/stable`）和 `--destructive-mode` 构建，不需要 LXD/Multipass。base 是 core24（Ubuntu 24.04 用户态），同一份 snap 可运行在 Ubuntu 22.04 / 24.04 / 最新版上。snapcraft 9.1+ 不能用：electron-builder 把桌面文件写在 `snap/gui/` 并设置 `desktop: meta/gui/<app>.desktop`，9.1 的中介逻辑会去不存在的 `snap/meta/gui/` 找它（[canonical/snapcraft#6519](https://github.com/canonical/snapcraft/issues/6519)）。
- 采用 **classic confinement**：应用要执行用户机器上的 CLI/工具，严格约束下这些都不可见。代价是 classic snap 不能直接自动上架 Snap Store（需要人工审核），本地安装要显式加 `--classic`：
  `sudo snap install --dangerous --classic ./kepcup_<version>_amd64.snap`
- 若以后要上架 Snap Store，先确认其经典约束审核政策；打包本身已就绪。

## 待补充

发版前需要确认或补齐的事项：

- [ ] **首跑验证**：第一次发版（建议 `0.1.0`）时观察 release.yml 全流程。重点看：Windows 在 x64 runner 上交叉编译 arm64 原生模块；`-c.appx.*` 覆盖项生效；`macos-15-intel` 上原生模块重编译；合并后的 `latest-mac.yml` 在 Intel 和 Apple Silicon 两种 Mac 上都能更新。
  - 已修：`scripts/dist.mjs` 用 `process.execPath` 直接跑 `electron-vite` / `electron-builder` CLI（避免 Windows 上 `spawnSync('pnpm')` 找不到 `pnpm.cmd`）；Linux `executableName: KepCup`（避免 AppImage 因 `@kepcup/desktop` 含 `@` 失败）。
- [ ] **自动更新端到端**：装 `0.1.0` → 发 `0.1.1` → 三平台确认能收到更新并安装（[todo/cross-platform-acceptance.md](../../todo/cross-platform-acceptance.md) P13「自动更新端到端」）。
- [ ] **商店版开机自启**：MSIX 里 `app.setLoginItemSettings` 不生效，需要在清单里声明 StartupTask（electron-builder `appx.customExtensionsPath`），运行时改用 StartupTask API。在此之前，商店版设置页的「开机自启」开关不起作用。
- [ ] **商店版更新界面**：应用内更新关闭后状态一直是 idle，点「检查更新」会显示「已是最新」，容易误导。商店/Flatpak/Snap 版应该显示「由 Microsoft Store / Flatpak / Snap 更新」。
- [ ] **Linux 新渠道首跑**：第一次带 rpm/flatpak/snap 的版本观察 `linux-rpm`（2 个容器 job）、`linux-rpm-verify`（4 个）、`linux-flatpak`、`linux-snap`。重点看 RHEL 9/10 容器里 `dnf install` 的依赖解析、es-git 源码重建耗时（vendored libgit2/openssl，约 10 分钟）、flatpak-builder 在 GitHub runner 上的 bwrap/rofiles-fuse 可用性。失败只影响该版本发布，修好后重跑工作流即可。
- [x] **Windows arm64 的 WSL rootfs**（2026-10-18 双架构接线解决）：rootfs job 现产 `resources/wsl/{x64,arm64}/` 双目录（arm64 容器跑在 qemu 上，`--platform` 与目标架构一一对应），electron-builder 按 `${arch}` 子目录取件；arm64 安装包不再带 x64 rootfs。**arm64 WSL2 真机自检仍留验证**——见 [todo/cross-platform-acceptance.md](../../todo/cross-platform-acceptance.md) P12。
- [ ] **品牌信息统一**：`apps/desktop/package.json` 的 `homepage`/`author.email` 用的是 `kepcup.app`，官方域名是 `kepcup.com`。商店和 Linux 包的元数据都会显示这些值。
- [ ] **隐私政策 URL**：Microsoft Store 提交要求提供（应用会访问网络、调用用户配置的模型服务）。
- [ ] 可选：winget（`wingetcreate` / Komac 可以在 CI 里自动给 winget-pkgs 提 PR）、Homebrew Cask。两者都会自动跟踪 GitHub Release 的新版本。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 推了 main 但没有发布 | 看 release 工作流 prepare job 的运行摘要：版本号没改（tag 已存在）、仍是 `0.0.0`，或带了预发布后缀 |
| Snap 报 `Failed to generate desktop file .../snap/meta/gui/kepcup.desktop` | snapcraft 9.1+ 回归。`linux-snap` 必须钉 `8.x/stable`，不要改回不带 `--channel` 的 `snap install snapcraft --classic` |
| RPM 冒烟报 `libnspr4.so: cannot open shared object file` | AlmaLinux 9 构建容器没装 Electron 运行时库。`dnf install` 要包含 `rpm.depends` 那一组（`nss` 带上 `nspr`），不能只写进 spec |
| RPM 报 `ruby: ... libcrypt.so.1: cannot open shared object file` | fpm 自带的 Ruby 需要 `libxcrypt-compat`。AlmaLinux 9 的 `libxcrypt` 只提供 `libcrypt.so.2` |
| macOS job 报 notarization 需要 3 个变量 | `APPLE_API_KEY_P8_PATH`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` 只填了一部分。同步脚本会拦截这种情况，但 GitHub 网页上手改机密时不会 |
| 公证失败 `The signature of the binary is invalid` | 证书类型不对（必须是 Developer ID Application），或 `.p12` 导出时没带私钥 |
| publish job 报 `expected 2 latest-mac.yml` | 某个 macOS job 没产出更新清单。看该 job 日志，通常是签名失败 |
| `store-upload.mjs` 报 no successful release.yml run 或下载失败 | 该 tag 对应提交的 release 工作流没成功，或 `store-msix` 工件已过期（90 天）。重跑工作流会因为 tag 已存在而跳过，所以过期的版本只能随下一个版本一起上商店；发版后尽快提交 |
| `msstore` 鉴权失败 | 客户端密钥过期，到 Partner Center 重新生成后更新 `.env.release` |
