import type { TaskSummary } from '../../tools/task-tools.js';

function ago(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时${minutes % 60 > 0 ? ` ${minutes % 60} 分钟` : ''}前`;
}

/**
 * Model-chosen title text is data, not instructions (审查 L4): wrapped in
 * <untrusted> like other bots' words, a stray closing tag neutralized.
 * Latest progress stays on the task card / UI only — not in this segment
 * (progress must not pollute the turn's context).
 */
function untrusted(text: string): string {
  return `<untrusted>${text.replace(/<\/?untrusted>/gi, (tag) => tag.replace('<', '‹').replace('>', '›'))}</untrusted>`;
}

function taskLine(task: TaskSummary, now: number): string {
  const parts = [`[${task.taskId}] ${untrusted(task.title)}`, task.state, writeLabel(task)];
  parts.push(`派出 ${ago(now - task.createdAt)}`);
  if (task.state === 'submitted') parts.push(`排队中（${task.queueReason ?? '等待启动'}）`);
  if (task.awaitingInput) parts.push('等待用户输入（问题卡已发给用户）');
  if (task.error) parts.push(`错误：${untrusted(task.error)}`);
  if (task.capabilities !== undefined && task.capabilities.length > 0) {
    parts.push(`能力：${task.capabilities.join('、')}`);
  }
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

/** D123: `写域 …` / `写（全域）` / `只读` for peer rows. */
function writeLabel(task: TaskSummary): string {
  if (!task.writes) return '只读';
  const domains = task.writeDomains;
  if (domains === null || domains === undefined || (domains.length === 1 && domains[0] === '**')) {
    return '写（全域）';
  }
  return `写域 ${domains.join(', ')}`;
}

function peerLine(task: TaskSummary): string {
  const parts = [`[${task.taskId}] ${untrusted(task.title)}`, task.state, writeLabel(task)];
  if (task.state === 'submitted') parts.push(`排队中（${task.queueReason ?? '等待启动'}）`);
  if (task.awaitingInput) parts.push('等待用户输入');
  return parts.join('  ');
}

/**
 * D123: the task loop's `<peer_tasks>` segment (design 59 §4.1) — sibling
 * tasks of the same (bot, conversation), the task itself excluded. No result
 * or progress text; titles stay `<untrusted>`. Deterministic, no model call.
 */
export function buildPeerTasksSegment(tasks: TaskSummary[], selfTaskId: string): string {
  const peers = tasks.filter((task) => task.taskId !== selfTaskId);
  if (peers.length === 0) return '';
  return [
    '<peer_tasks>',
    '（同一对话中与你并行/相邻的任务；这是它们的状态，不含你自己。可以 send_to_task 协商、wait_for_task 等它们结束）',
    ...peers.map(peerLine),
    '</peer_tasks>',
  ].join('\n');
}
