import type { TaskSummary } from '../../tools/task-tools.js';

function ago(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时${minutes % 60 > 0 ? ` ${minutes % 60} 分钟` : ''}前`;
}

/**
 * Model-chosen / task-produced text (the title start_task was given, the
 * task's latest progress line) is data, not instructions (审查 L4): wrapped in
 * <untrusted> like other bots' words, a stray closing tag neutralized.
 */
function untrusted(text: string): string {
  return `<untrusted>${text.replace(/<\/?untrusted>/gi, (tag) => tag.replace('<', '‹').replace('>', '›'))}</untrusted>`;
}

function taskLine(task: TaskSummary, now: number): string {
  const parts = [`[${task.taskId}] ${untrusted(task.title)}`, task.state, task.writes ? '写' : '只读'];
  parts.push(`派出 ${ago(now - task.createdAt)}`);
  if (task.state === 'submitted') parts.push(`排队中（${task.queueReason ?? '等待启动'}）`);
  if (task.awaitingInput) parts.push('等待用户输入（问题卡已发给用户）');
  if (task.lastProgress !== null) parts.push(`最近：${untrusted(task.lastProgress)}`);
  parts.push(`可注入：${task.injectable ? '是' : '否'}`);
  return parts.join('  ');
}

/**
 * The turn's `<tasks>` segment (D75 design 30 §4.2): the bot's in-flight
 * (submitted / running) tasks in this conversation — their state is mutable;
 * settled tasks already sit in the timeline as private entries and are not
 * repeated. Deterministic, no model call. Empty when nothing is in flight.
 */
export function buildTasksSegment(tasks: TaskSummary[], now: number): string {
  const inFlight = tasks.filter((task) => task.state === 'submitted' || task.state === 'running');
  if (inFlight.length === 0) return '';
  return [
    '<tasks>',
    '（你在本对话中进行中与排队中的任务；已结束任务的交代与结果在对话记录里）',
    ...inFlight.map((task) => taskLine(task, now)),
    '</tasks>',
  ].join('\n');
}
