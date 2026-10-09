# P10 主动消息与调度

## 目标

Bot 可以创建定时任务、在承诺到期时主动发消息、在事件发生时继续工作；休眠错过的任务在唤醒后补执行并告知 Bot 迟到了多久；主动消息受免打扰时段与每日上限约束；用户可以查看并取消所有定时任务。

## 依赖

P07。

## 设计依据

- [design/02-execution.md](../../design/02-execution.md#主动消息)（触发类型、护栏、错过的定时任务）
- [design/04-memory.md](../../design/04-memory.md)（承诺与调度器联动、承诺作废）
- [design/03-bot.md](../../design/03-bot.md#profile)（`behavior`：`proactive`、`quiet_hours`、`max_proactive_per_day`）
- [03-data-model.md](../03-data-model.md)（schedules）

## 范围

包含：

- schedules 表；工具 `schedule`、`list_schedules`、`cancel_schedule`。
- 承诺联动：带 `due_at` 的承诺（`remember` 或反思产生）自动创建一次性定时任务（提前量默认 0，即到期时触发），承诺作废时定时任务取消。
- 定时服务：计算 `next_fire_at`，到期时登记 `schedule_fire` 任务，投递到 Mailbox（`trigger_reason = 'scheduled'`，优先级 1）。
- 错过的任务：应用启动与电源恢复（主进程经端口 B 转发 `powerMonitor` 的 `resume` 事件）时扫描已过期未触发的任务，补触发并带 `late_by`。周期任务错过多次只补触发一次。
- 护栏：Profile `behavior.proactive = false` 时不触发（任务保留，界面提示）；免打扰时段内的触发推迟到时段结束；每日主动消息上限（`max_proactive_per_day`，默认 `MAX_PROACTIVE_PER_DAY`），超出后当天剩余的触发推迟到次日并在界面提示。
- 统一的事件触发入口：`environment_installed`（P06 已有）、`wiki_ingested`（P09 已有）接入同一个护栏检查（事件触发不受每日上限约束，但受免打扰时段约束）。
- 界面：右栏“定时任务”列表（当前对话中各 Bot 的任务，显示下次触发时间、说明、取消按钮）；设置页汇总所有定时任务。
- 生命周期：删除对话、移出群、删除 Bot 时取消相关任务。

不包含：

- 外部 webhook（设计中为“后续可接”，本阶段不做）。

## 任务

1. **工具**

   | 工具 | 参数 | 行为 |
   |---|---|---|
   | `schedule` | `when`（ISO 时间，或 cron 表达式 + 时区）、`note` | 为当前对话创建定时任务；时间在过去时返回错误 |
   | `list_schedules` | — | 本 Bot 在当前对话中的有效任务 |
   | `cancel_schedule` | `schedule_id` | 只能取消自己的任务 |

2. **定时服务**（`schedule/timer.ts`）：启动时加载 `status = 'active'` 的任务；使用单个定时器指向最近的 `next_fire_at`，触发后重新计算；cron 解析使用成熟的小型库（例如 `cron-parser`，属于小型工具库）。
3. **触发**（`schedule/fire.ts`）：检查护栏 → 通过则投递 Mailbox（该 Bot 在该对话中正在执行时注入，否则新建执行）→ 更新 `last_fired_at`；一次性任务标记为 `done`；承诺对应的任务触发后，在触发段中附上承诺内容。
4. **错过补触发**：`late_by = now - 应触发时间`，超过 1 分钟才标注；触发段中 `late_by` 以人类可读格式呈现（例如“2 小时 15 分钟”）。
5. **护栏**（`schedule/guard.ts`）：免打扰时段按用户本地时区判断；每日计数按本地日期；计数只统计因定时触发而**实际发出消息**的执行（Bot 被触发后选择 `skip_reply` 不计数）。
6. **承诺联动**（`memory/` 与 `schedule/` 之间通过事件总线）：承诺创建 → 创建任务并写 `commitment_id`；承诺被置为 `void` / `retracted` → 取消任务。
7. **界面**：定时任务列表与取消；被护栏推迟时，任务项显示“已推迟：免打扰时段 / 今日主动消息已达上限 / 该 Bot 已关闭主动消息”。

## 接口与数据

- 新增表：`schedules`。
- 新任务类型：`schedule_fire`。
- 端口 B 新增主进程 → 核心服务事件：`power.resume`、`power.suspend`。
- RPC：`schedules.list(conversationId?)`、`schedules.cancel`。

## 测试要求

- 单元：cron 下次触发时间计算（含时区、夏令时）；免打扰时段判断（跨午夜）；每日上限计数。
- 集成（`infra/clock` 使用可控时钟）：
  - Bot 调用 `schedule` 一分钟后 → 时钟前进 → 执行被触发，触发段为 `scheduled`。
  - 承诺带截止时间 → 自动创建任务 → 到期触发，触发段包含承诺内容；删除对话 → 承诺作废、任务取消。
  - 模拟休眠 3 小时后 `power.resume` → 补触发，`late_by` 约 3 小时；周期任务错过 3 次只补 1 次。
  - 免打扰时段内的触发推迟到时段结束；达到每日上限后推迟到次日；`skip_reply` 不计数。
  - Profile 关闭主动消息后不触发。
  - 移出群、删除 Bot 后相关任务取消。
- 端到端：定时任务列表显示与取消。

## 验收标准

- [ ] Bot 答应“周五提醒你”后，到时间会主动在对话中发消息。
- [ ] 电脑休眠期间错过的任务，唤醒后补执行，Bot 知道自己迟到了多久并据此决定是否发送。
- [ ] 免打扰时段、每日上限、关闭主动消息三种护栏生效，界面说明被推迟的原因。
- [ ] 用户可以查看并取消所有定时任务。
- [ ] 删除对话、移出群、删除 Bot 时相关任务被取消，承诺作废。
- [ ] 本阶段测试全部通过（迭代中跑定向测试，收口跑一次全量，见 [05-testing.md](../05-testing.md#开发中如何跑测试)）。

## 注意事项

- 定时触发与用户消息共用同一个 Mailbox，保证同一“Bot + 对话”同一时刻只有一个响应 loop。
- 不要用多个 `setTimeout` 对应多个任务；只维护一个指向最近任务的定时器。
