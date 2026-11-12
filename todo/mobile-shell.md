# 手机原生壳(D122)执行方案

> 设计:[docs/design/58-mobile-shell.md](../docs/design/58-mobile-shell.md)。目标:手机 App(Capacitor 原生壳)替代浏览器 PWA 的运行环境,扫码 / 输入地址 / 最近连接三种方式连桌面(D96)与 headless(D102)。

## 现状基线

- 手机 PWA = renderer web 构建(`apps/desktop/vite.config.web.ts`),由中转 Worker(remote.kepcup.com)或 headless(apps/server/web)同源托管,已在生产运行。
- 配对链路:E2E(X25519 + AES-256-GCM)、凭证 sessionStorage、设备 id localStorage、token 重连——全部现成。
- 无任何 iOS / Android 工程痕迹;有 Xcode 工具链使用先例(macOS Share Extension)。

## WP1 P0:脚手架与设计文档

- [x] 设计文档 58 + 本文件
- [x] `apps/mobile` workspace 包:package.json / capacitor.config.ts / vite + svelte + tailwind / tsconfig / ESLint 通行
- [x] `cap add android` + `cap add ios`,权限与明文 http 配置(Info.plist、network_security_config)
- [x] 首页空壳可构建、真机可安装(dev 直装,不追求图标)
- [x] vitest 加 `mobile` / `mobile-svelte` 项目

## WP2 P1:连接闭环

- [x] 首页三入口:扫码(native scanner)/ 手动地址输入(连通性预检)/ 最近连接(Preferences 持久化)
- [x] `parsePairingLink` 抽到 `packages/shared`(domain/pairing-link.ts),renderer re-export,shared build + 定向测试
- [x] renderer 壳模式三小改:`getWebTransport` localStorage 注入、Gate「断开」按钮、web-main 跳过 SW
- [ ] 真机验收矩阵(iOS + Android 各一):
  - [ ] 桌面中转扫码配对(桌面出码 → App 扫码 → 确认 → 全功能遥控)
  - [ ] LAN headless 直连配对(`--host 0.0.0.0 --auth pairing`)
  - [ ] headless 密码模式登录
  - [ ] 杀进程冷启动 → 最近连接一键重连(凭证保留)
  - [ ] 断开 → 首页 → 重连;后台切换不断链;**断开后按返回键不得退回客户端页**(D122 审查修复的回归项)
  - [ ] 非配对二维码 / 错误地址给出明确提示
  - [ ] **桥暴露面 PoC(审查新增)**:在所连页面里调 `Capacitor.isNativePlatform()` / 一个插件(如 Preferences),记录 iOS / Android 的真实暴露面,回填 design 58 §1.2
- [ ] `?shell=native` 不影响普通浏览器路径(既有 web 冒烟 + 定向测试)

## WP3 P2:打磨

- [x] 图标(单一源图 KepCup.svg → `pnpm --filter @kepcup/mobile icons`;iOS 单尺寸 + Android 三套;启动屏仍用系统默认,待需求)
- [ ] `kepcup://` scheme 预留(iOS CFBundleURLTypes + Android intent-filter,首页接 appUrlOpen)
- [ ] 桌面配对弹窗加「用手机 App 连接」提示文案
- [ ] Android APK 构建脚本(`cap sync` + gradle assembleRelease)与直装文档
- [x] iOS TestFlight 首个构建上传(2026-11-11,流程见验收记录)

## WP4 P3(另行立项,不阻塞)

- [ ] 推送(APNs/FCM + 转发服务;外部页面桥注入问题需先解决)
- [ ] mDNS 局域网自动发现
- [ ] 设备凭证迁 Keychain / Keystore
- [ ] 商店上架(App Store「最低功能性」评估)

## 验收记录

- **2026-11-11(P0 + P1 代码侧完成)**:`apps/mobile` 脚手架(Capacitor 8.6.0 + Svelte 5.57.1 + Tailwind 4.3.3,与 renderer 同版本);首页三入口 + 30 个单测(connect/target-model/targets store);renderer 壳模式三小改 + 5 个定向测试;shared 上移 + 663 项定向测试全绿;双包 typecheck 0 错;lint 0 错。坑与择优:
  - **扫码插件**:`@capacitor-mlkit/barcode-scanning` 只有 podspec,iOS SPM 工程不兼容(cap sync 警告插件缺失)。换官方 `@capacitor/barcode-scanner@3.1.3`(Package.swift + podspec 双支持,Android 走 ML Kit 引擎,SPM 警告消失)。
  - **既有问题顺手修**:web 冒烟(smoke.spec.ts)2 例在干净树上同样失败——`vite preview` 把 `/api/auth/whoami` SPA 回退成 200+HTML,D102 探测层(只看状态码)误判「密码模式已登录」,Gate 卡 booting。修复:`vite.config.web.ts` 加 `preview-no-spa-fallback` 中间件(`/api/*`、`/admin/*` 直通 404,对齐真实部署语义)。修复后 3 例全过。
- **2026-11-11(TestFlight 首个构建上传成功)**:版本 0.5.10 (build 1),Delivery UUID `3393df01-d293-44c9-982f-0861ca13e33d`。全程零 GUI,关键事实与坑:
  - **Bundle ID 决策**:ASC 的 KepCup 记录是「单记录多平台」,Bundle ID `app.kepcup.desktop` 同时承载 macOS 与 iOS(SKU 才是 app.kepcup.mobile)。工程 iOS/Android/capacitor 配置统一改用 `app.kepcup.desktop`;Android 侧同步移动 MainActivity 包路径。
  - **无设备团队签名**:团队没有注册过 iOS 设备,Apple Development 描述文件建不了;分发链路不需要设备——用 API key 创建 `IOS_DISTRIBUTION` 证书(CSR 本地 openssl 生成 → `POST /v1/certificates`)、创建 `IOS_APP_STORE` 描述文件(`POST /v1/profiles`)、本地免签归档(`CODE_SIGNING_ALLOWED=NO`)→ `exportArchive` 手动签名(destination=export)→ `xcrun altool --upload-app --apiKey` 上传。**云签名(cloud-managed)这条线走不通**:API key 是「开发者」角色,无 cloud signing 权限——本地证书 + 手动签名绕过。
  - **可复用产物**:`apps/mobile/release/exportOptions.plist`(手动签名模板)、ASC API 的 ES256 JWT 生成/证书/描述文件调用已在 todo 留档,后续自动化(WP3 的构建脚本)直接照抄。
