import type { TaskView } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

/**
 * D116 每 Bot 任务列表（docs/design/56 §2）：Bot 详情「任务」tab 的数据源，
 * `tasks.listByBot`（跨对话全集，created_at 倒序）+ `task.updated` 按 botId
 * 过滤续期。RightPanel 的 tab 触发器徽标（进行中数）与 BotTasksPanel 面板
 * 共用这一份状态——单 store 键定当前 Bot，换 Bot 即整体重载。
 *
 * 一致性约定：`items` 只可能为空或属于当前 `botId`——换 Bot 的 load 一开始就
 * 清空列表（拉取失败也不把上一个 Bot 的任务算到新 Bot 头上）；响应落地时与
 * 在途推送做 upsert 合并（快照不会覆盖掉期间到达的推送），按 createdAt 倒序。
 */
class BotTasksState {
  /** 当前列表归属的 Bot；null = 尚未加载。 */
  botId = $state<string | null>(null);
  items = $state<TaskView[]>([]);
  loading = $state(false);
  #started = false;
  /** Latest-wins：慢响应不得覆盖新一次 load（仿 tasks store 的 seq 规则）。 */
  #seq = 0;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('task.updated', (payload) => {
      const view = (payload as { task?: TaskView }).task;
      if (view === undefined || view.botId !== this.botId) return;
      const index = this.items.findIndex((entry) => entry.taskId === view.taskId);
      if (index >= 0) {
        // 已有行原位替换：终态更新不打破顺序。
        const next = [...this.items];
        next[index] = view;
        this.items = next;
      } else {
        // 新派的任务是最新的：插到最前（进行中组随之出现）。
        this.items = [view, ...this.items];
      }
    });
  }

  async load(botId: string): Promise<void> {
    this.start();
    const seq = (this.#seq += 1);
    // 换 Bot 先清空：items 永远只属于当前 botId（失败也保持空，不错配徽标）。
    if (this.botId !== botId) this.items = [];
    this.botId = botId;
    this.loading = true;
    try {
      const result = (await core.call('tasks.listByBot', { botId })) as {
        tasks: TaskView[];
      };
      if (seq !== this.#seq || this.botId !== botId) return;
      // upsert 合并：响应是请求时刻的快照，在途推送插入的行（较新）保留。
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 合并用的临时台账，不进 UI 状态。
      const merged = new Map(this.items.map((entry) => [entry.taskId, entry]));
      for (const view of result.tasks) merged.set(view.taskId, view);
      this.items = [...merged.values()].sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      // 拉不到就保留当前列表（换 Bot 场景已是空列表）；tab 里有手动刷新。
    } finally {
      if (seq === this.#seq) this.loading = false;
    }
  }
}

export const botTasks = new BotTasksState();
