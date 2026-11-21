# 63 闭源边界：团队服务器拆分（apps/team-server 嵌套私有仓）

> 状态：**已实施（2026-11-21）**。上游设计：62 号系列（团队服务器 D126–D138，内部文档，随闭源仓推进）。

## 1. 背景与决策

团队服务器（`apps/team-server`）与管理台（`@kepcup/team-console`）是 KepCup 的商业化组件：自托管多成员、按席位授权。决策（2026-11-21）：

- **单私有仓** `jooler/kepcup-team-server`：根目录放公共内容（README / workspace 布局 / .gitignore），`server/` 与 `console/` 两个子目录分别对应两个包；62 号设计文档与 `todo/team-server` 执行记录整体迁入私有仓 `docs/`、`todo/`。
- **公开仓只保留占位**：`apps/team-server/` 路径下只跟踪一个说明 README，其余内容由 `.gitignore` 兜底；`apps/team-console/` 并入后从公开结构移除。
- **开发仍全部在宿主 monorepo 推进**：私有仓以嵌套 clone 挂载在 `apps/team-server/`，两个包保留在宿主 pnpm workspace（显式登记），`pnpm --filter`、根 vitest、typecheck 全部照常。
- 已公开的历史（`origin/team-server` 分支上的 62 设计文档与 todo）经 `git filter-repo` 重写清除后 force push；旧分支SHA 级残留接受不处理（fork 已存在）。

## 2. 目录拓扑

```
jooler/kepcup（公开仓，本仓）                    jooler/kepcup-team-server（私有仓，main）
├── apps/team-server/                            ├── README.md        ← 双用途（公开说明 + 内部指引）
│   └── README.md   ← 唯一被公开仓跟踪的文件      ├── package.json / pnpm-workspace.yaml / .gitignore
└── （其余为开源内容）                            ├── server/    ← @kepcup/team-server（含原 README.md）
                                                 ├── console/   ← @kepcup/team-console
                                                 ├── docs/design/62-team-server/  ← 12 篇设计文档
                                                 └── todo/team-server/            ← T0–T11 执行记录
```

私有仓整体 clone 到公开仓的 `apps/team-server/`（真实目录、无 symlink）；两仓共享
根 `README.md` 的物理文件（同内容、两仓各自提交）。宿主仓 `.gitignore` 规则：

```
apps/team-server/*
!apps/team-server/README.md
```

## 3. 依赖方向

```
desktop（开源）──▶ @kepcup/shared 契约（开源：packages/shared/src/team/）◀── server（闭源实现）
desktop（开源）──▶ core 主体缝 C1–C15（开源、默认休眠）◀────────────────── server（闭源，嵌入 createCoreServices）
console（闭源）──▶ /api/console/*（HTTP 面）◀───────────────────────────── server（闭源，托管 /console/ 静态面）
```

- `packages/core` 中关于 62 号设计的注释保留（语义仍有效；指向的文档路径随迁移
  悬空，属已知噪音）。
- `packages/shared` 的 team 契约与 `remote-team-server` 设置目录条目是客户端
  （开源）依赖面，保持开源。

## 4. CI 与 lockfile

- 公开 checkout 中 `apps/team-server/` 没有 `package.json`：根 `vitest.config.ts`
  的 `team-server` / `team-console` 项目按存在性条件注册，自动跳过；`pnpm-workspace.yaml`
  的显式登记项因目录不存在而不匹配（glob 语义，零命中不报错）。
- `pnpm-lock.yaml` 本地会带闭源包的 importer 段（仅泄露依赖元数据，可接受）；
  公开 CI 在 `pnpm install --frozen-lockfile` 前跑 `scripts/prune-lockfile-importers.mjs`
  剪除「无 package.json 目录」的 importer（通用逻辑，不点名组件）。
- 私有仓根 `pnpm-workspace.yaml`（`packages: [server, console]`）供独立 checkout
  的结构表达；独立安装需先组合开源仓的 `@kepcup/core` / `@kepcup/shared`（独立
  CI/部署为遗留项）。

## 5. 日常开发流程

| 改动类型 | 提交位置 | 推送 |
|---|---|---|
| 开源（desktop / packages / docs / infra） | 宿主仓根 | `origin`（`team-server` 分支或 main 流程） |
| 闭源（server / console / 62 文档 / todo） | `apps/team-server/` 内（= 私有仓根） | 私有仓 `main` |
| 跨两侧的功能 | 分别提交（先闭源后开源或反之） | 各自推送 |

约束：

1. **不要把私有仓内容复制进公开仓文件**；公开侧引用闭源实现路径
   （`apps/team-server/server/...`）会指向不存在的目录，公开 checkout 编译/测试
   必须不依赖这些路径存在（现有 desktop e2e 的 team-fusion spec 以
   `KEPCUP_TEAM_E2E=1` 门控即为先例）。
2. **pnpm 命令只在宿主仓根执行**；`apps/team-server/` 里有私有仓自己的
   pnpm workspace。
3. **勿对宿主仓跑 `git clean -x`**（含 `-fdx`）：会删掉整个嵌套私有仓（含 `.git`，
   未推送提交丢失；仓本身可从私有远端重 clone）。
4. 根 `apps/team-server/README.md` 双仓跟踪，改动需两边各提交一次。
5. 新协作者初始化：clone 宿主仓 → `gh repo clone jooler/kepcup-team-server apps/team-server` → 宿主仓根 `pnpm install`。

## 6. 历史处理记录（2026-11-21）

- 私有仓：`git filter-repo --path apps/team-server --path docs/design/62-team-server --path todo/team-server`（两遍：先抽路径、再剥 `apps/team-server/` 前缀），25 个闭源提交 + 根内容提交，`team-server` 分支更名为 `main`。
- 公开仓：`git filter-repo --invert-paths` 移除 `apps/team-server`、`apps/team-console`、`docs/design/62-team-server`、`todo/team-server` 四个路径的全部历史，`team-server` 分支 force push 覆盖（旧 SHA 残留接受）。
- 拆分前的结构重组（`apps/team-console` 并入 `apps/team-server/console/`、server 自身收进 `apps/team-server/server/`、跨包相对路径修正、deploy Dockerfile/compose 改为以私有仓根为 context）作为最后一个混合提交随两仓历史分别保留。
