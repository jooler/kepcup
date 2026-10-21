/**
 * 状态行的工具名 → 动词短语映射（docs/design/12-ui-layout.md 焦点二、
 * todo/loop-interim-updates.md）：已知工具映射为 i18n 动词短语，配合
 * `runStatus.callingVerb`（「正在{verb}…」）；`browser_*` 系列统一为
 * 「操作浏览器」；未识别的工具返回 null，调用方回退
 * `runStatus.callingTool`（「正在调用 {tool}…」）。
 * 工具清单来源：packages/core/src/tools/（含 pi-coding-agent 的
 * read/write/edit/ls/find/grep/bash）。
 */
import { t, type MessageKey } from '$lib/i18n';

const TOOL_VERBS: Record<string, MessageKey> = {
  bash: 'runStatus.tool.bash',
  powershell: 'runStatus.tool.powershell',
  read: 'runStatus.tool.read',
  write: 'runStatus.tool.write',
  edit: 'runStatus.tool.edit',
  ls: 'runStatus.tool.ls',
  find: 'runStatus.tool.find',
  grep: 'runStatus.tool.grep',
  send_message: 'runStatus.tool.send_message',
  skip_reply: 'runStatus.tool.skip_reply',
  search_messages: 'runStatus.tool.search_messages',
  get_messages_around: 'runStatus.tool.get_messages_around',
  get_attachment: 'runStatus.tool.get_attachment',
  list_my_runs: 'runStatus.tool.list_my_runs',
  get_run: 'runStatus.tool.get_run',
  request_access: 'runStatus.tool.request_access',
  request_unsandboxed: 'runStatus.tool.request_unsandboxed',
  acquire_workdir_write: 'runStatus.tool.acquire_workdir_write',
  git_remote: 'runStatus.tool.git_remote',
  request_environment: 'runStatus.tool.request_environment',
  create_skill: 'runStatus.tool.create_skill',
  ask_question: 'runStatus.tool.ask_question',
  remember: 'runStatus.tool.remember',
  recall_memory: 'runStatus.tool.recall_memory',
  forget: 'runStatus.tool.forget',
  get_user_profile: 'runStatus.tool.get_user_profile',
  list_commitments: 'runStatus.tool.list_commitments',
  memory_feedback: 'runStatus.tool.memory_feedback',
  propose_profile_change: 'runStatus.tool.propose_profile_change',
  schedule: 'runStatus.tool.schedule',
  list_schedules: 'runStatus.tool.list_schedules',
  cancel_schedule: 'runStatus.tool.cancel_schedule',
  watch_create: 'runStatus.tool.watch_create',
  watch_list: 'runStatus.tool.watch_list',
  watch_stop: 'runStatus.tool.watch_stop',
  wiki_search: 'runStatus.tool.wiki_search',
  wiki_read: 'runStatus.tool.wiki_read',
  wiki_enqueue: 'runStatus.tool.wiki_enqueue',
  wiki_remove_source: 'runStatus.tool.wiki_remove_source',
  save_profile: 'runStatus.tool.save_profile',
  finish_setup: 'runStatus.tool.finish_setup',
  list_bots: 'runStatus.tool.list_bots',
  propose_bots: 'runStatus.tool.propose_bots',
  propose_bot: 'runStatus.tool.propose_bot',
  propose_project: 'runStatus.tool.propose_project',
  suggest_route: 'runStatus.tool.suggest_route',
  delegate_to_bot: 'runStatus.tool.delegate_to_bot',
  cancel_delegation: 'runStatus.tool.cancel_delegation',
  // D91 能力目录按需发现两件套。
  capability_search: 'runStatus.tool.capability_search',
  capability_call: 'runStatus.tool.capability_call',
};

export function toolVerb(toolName: string): string | null {
  const known = TOOL_VERBS[toolName];
  if (known !== undefined) return t(known);
  if (toolName.startsWith('browser_')) return t('runStatus.tool.browser');
  return null;
}
