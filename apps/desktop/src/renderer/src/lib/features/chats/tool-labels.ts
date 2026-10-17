/**
 * 状态行的工具名 → 动词短语映射（docs/design/12-ui-layout.md 焦点二、
 * todo/loop-interim-updates.md）：已知工具映射为中文动词短语，配合
 * `runStatus.callingVerb`（「正在{verb}…」）；`browser_*` 系列统一为
 * 「操作浏览器」；未识别的工具返回 null，调用方回退
 * `runStatus.callingTool`（「正在调用 {tool}…」）。
 * 工具清单来源：packages/core/src/tools/（含 pi-coding-agent 的
 * read/write/edit/ls/find/grep/bash）。
 */
const TOOL_VERBS: Record<string, string> = {
  bash: '执行命令',
  powershell: '执行命令',
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  ls: '查看目录',
  find: '查找文件',
  grep: '搜索内容',
  send_message: '发送消息',
  skip_reply: '判断是否回应',
  search_messages: '检索对话',
  get_messages_around: '查看消息上下文',
  get_attachment: '读取附件',
  list_my_runs: '查看执行记录',
  get_run: '查看执行记录',
  request_access: '申请访问授权',
  request_unsandboxed: '申请沙箱外执行',
  acquire_workdir_write: '申请工作目录写入',
  git_remote: '执行 git 操作',
  request_environment: '安装运行环境',
  create_skill: '生成技能',
  ask_question: '向你提问',
  remember: '保存记忆',
  recall_memory: '回忆相关记忆',
  forget: '删除记忆',
  get_user_profile: '查看用户画像',
  list_commitments: '查看承诺清单',
  memory_feedback: '纠正记忆',
  propose_profile_change: '提议修改 Profile',
  schedule: '创建定时任务',
  list_schedules: '查看定时任务',
  cancel_schedule: '取消定时任务',
  watch_create: '创建网页监看',
  watch_list: '查看网页监看',
  watch_stop: '停止网页监看',
  wiki_search: '检索 Wiki',
  wiki_read: '阅读 Wiki',
  wiki_enqueue: '整理资料入库',
  wiki_remove_source: '正在删除项目 wiki 来源…',
  save_profile: '保存 Profile',
  finish_setup: '完成初始化',
  list_bots: '查看通讯录',
  propose_bots: '提议组建团队',
  propose_bot: '提议新建 Bot',
  propose_project: '提议建项目组',
  suggest_route: '给出路由建议',
  delegate_to_bot: '转交给其他 Bot',
  cancel_delegation: '取消转交',
  // D91 能力目录按需发现两件套。
  capability_search: '查找外部工具',
  capability_call: '调用外部工具',
};

export function toolVerb(toolName: string): string | null {
  const known = TOOL_VERBS[toolName];
  if (known !== undefined) return known;
  if (toolName.startsWith('browser_')) return '操作浏览器';
  return null;
}
