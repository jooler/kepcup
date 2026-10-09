# KepCup 编程 Agent 约定

开发流程与规范见 [docs/dev/README.md](docs/dev/README.md)；测试细则见 [docs/dev/05-testing.md](docs/dev/05-testing.md#开发中如何跑测试)。

## 测试：先定向、后全量

- 迭代中只跑与改动相关的测试：`node scripts/run-tests.mjs run <测试文件或目录>`（可加 `-t "用例名"`），或单包 `pnpm --filter @kepcup/<包> test`；类型检查同理用 `pnpm --filter @kepcup/<包> typecheck`。
- 全量 `pnpm test` 只在三种情况跑：阶段收口或最终交付前跑**一次**；改了跨包公共部分（shared 契约、testkit、迁移、vitest 配置）；用户明确要求。
- 不做连续多轮全量；偶发失败只单跑该文件复核。改动前不重跑全量建基线，引用已记录的基线。
- PROGRESS.md 里「连续 N 轮全绿」是历史取证记录，不是要照做的流程。
