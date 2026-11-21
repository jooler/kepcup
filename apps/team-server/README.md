# apps/team-server — 闭源组件（KepCup 团队服务器）

本目录承载 KepCup 的**闭源商业组件**：团队服务器与管理台。开源仓（本仓）只保留
这一个说明文档；真实代码在私有仓 [jooler/kepcup-team-server](https://github.com/jooler/kepcup-team-server)
中，本地以**嵌套仓**形式挂载在本路径下。

## 这是什么

| 私有仓子目录 | 内容 | 宿主 workspace 包名 |
|---|---|---|
| `server/` | 团队服务器（`@kepcup/team-server`）：嵌入开源 `@kepcup/core` 引擎 + 团队层（成员账号、认证、方法策略、可见性、项目决议、用量分摊） | `apps/team-server/server` |
| `console/` | 独立管理台前端（`@kepcup/team-console`）：Astryx + React，由 server 在 `/console/` 同源托管 | `apps/team-server/console` |
| `docs/design/62-team-server/` | 团队服务器设计文档（62 号系列，内部） | — |
| `todo/team-server/` | 执行方案与任务记录（T0–T11，内部） | — |

**为什么闭源**：团队层是 KepCup 的商业化边界（自托管多成员、按席位授权）；开源的
是客户端（desktop）与共享契约（`packages/shared/src/team/`），以及
`packages/core` 中默认休眠的「主体缝」。设计决策见开源仓
[docs/design/63-closed-source-team-server.md](../../docs/design/63-closed-source-team-server.md)。

## 本地开发（有私有仓访问权限的协作者）

```bash
# 1. clone 开源宿主仓（jooler/kepcup）后，把私有仓嵌套 clone 到挂载根：
gh repo clone jooler/kepcup-team-server apps/team-server

# 2. 在宿主仓根执行（不要在 apps/team-server 里跑 pnpm——那是私有仓自己的 workspace）：
pnpm install
pnpm --filter @kepcup/team-server test    # 308 个服务端测试
pnpm --filter @kepcup/team-console build  # 管理台构建 → console/dist/
pnpm test                                  # 根 vitest 会自动注册 team 项目
```

- 闭源改动：在 `apps/team-server/` 内提交并 `git push`（remote 指向私有仓 `main`）。
- 开源改动：在宿主仓根提交推送。
- 根 `README.md` 同时被宿主仓与本仓跟踪（双用途：公开说明 + 内部指引），改动需在
  两边各提交一次。
- **勿对宿主仓跑 `git clean -x`**：会把整个嵌套私有仓（含 `.git`）删掉。
- CI / lockfile：公开 checkout 中本目录没有 `package.json`，根 vitest 项目按
  存在性条件注册自动跳过，`scripts/prune-lockfile-importers.mjs` 在 CI install
  前剪除本目录相关的 lockfile importer；本地开发时两者自动恢复，行为不变。
