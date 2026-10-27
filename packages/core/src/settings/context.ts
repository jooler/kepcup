import { SETTING_DIRECT_TRIGGERS, type Message, type TriggerReason } from '@kepcup/shared';

/**
 * 档位裁定的 run 上下文（todo/conversational-app-setup.md §5.3 第 1、2 条）：本 run 的触发是否
 * 来自用户本人、本 run 是否接触过不可信内容。纯函数，orchestrator 在 run 开始时 / 工具调用时用。
 */

/**
 * 触发批是否「用户本人发起」：批里每条消息都是用户本人发的普通消息——不是组件回传
 * （`origin: 'widget'`）、不是跨 Bot 代发（`origin: 'delegation'`），也没有系统事件或其他 Bot
 * 的发言（项目组里其他 Bot 的 mention / reply、邮件 / 监看 / 定时唤醒的内部事件都会让它为 false）。
 * 合并批（D75 §3.2）的每一部分的触发原因也都必须在直改白名单里。空批 = false。
 */
export function triggerFromUser(input: {
  messages: readonly Message[];
  /** 合并批各部分的触发原因（缺省 = 单批，只看 `reason`）。 */
  partReasons?: readonly TriggerReason[] | undefined;
}): boolean {
  if (input.messages.length === 0) return false;
  if (
    input.partReasons !== undefined &&
    !input.partReasons.every((r) => SETTING_DIRECT_TRIGGERS.has(r))
  ) {
    return false;
  }
  return input.messages.every((message) => {
    if (message.senderType !== 'user' || message.kind !== 'text') return false;
    return (message.content as { origin?: string } | undefined)?.origin === undefined;
  });
}

/**
 * 不会把外部内容带进本 run 的工具（§5.3 第 2 条的反面，白名单）：宿主自己的读写、出卡、发消息、
 * 记忆写入、定时等。**不在这里的一律按不可信处理**（含 `mcp_*`、`app_*` 连接工具与以后新增的
 * 工具）——新工具必须在这里或 {@link UNTRUSTED_TOOLS} 里显式登记（单测强制），默认偏严。
 */
export const TRUSTED_TOOLS: ReadonlySet<string> = new Set([
  // 对话与发消息
  'send_message',
  'skip_reply',
  'present',
  // 设置、定时、记忆写入（Bot 自己的输入，不读外部内容）
  'settings_search',
  'settings_read',
  'settings_change',
  'schedule',
  'list_schedules',
  'cancel_schedule',
  'offer_schedule',
  'watch_stop',
  'remember',
  'forget',
  'memory_feedback',
  'get_user_profile',
  'wiki_enqueue',
  // D92 T1b WP10: a hosted write registering a queued removal (receipt only).
  'wiki_remove_source',
  // 提问 / 提议（结果是用户的决定或宿主回执）
  'ask_user',
  'ask_question',
  'propose_profile_change',
  'propose_bots',
  'propose_bot',
  'propose_project',
  'propose_handover',
  'suggest_route',
  'save_profile',
  'finish_setup',
  // 任务与委派的管理动作（结果另由任务结果 / 委派结果送回，那条路径按不可信看待）
  'start_task',
  'inject_task',
  'cancel_task',
  'forward_task_result',
  'delegate_to_bot',
  'cancel_delegation',
  'list_bots',
  // 工作台（D90）：写入是宿主侧的事项 / 备忘变更，只回执（list_* 读用户写的内容，在 UNTRUSTED_TOOLS）
  'create_todo',
  'update_todo',
  'close_todo',
  'create_memo',
  'update_memo',
  'delete_memo',
  // 宿主侧的写、申请与安装（只回执，不回外部内容）
  'write',
  'edit',
  'delete',
  'request_access',
  'acquire_workdir_write',
  'request_environment',
  'create_skill',
  'generate_image',
  'generate_speech',
  'generate_video',
  'widget_publish',
  'mail_accounts',
  'mail_request_setup',
  'mail_send',
  'app_request_connection',
  'app_local_connector_guide',
  'app_propose_local_connector',
  // 插件安装请求只记下确认卡需求（宿主校验，不读外部内容）
  'plugin_request_install',
]);

/**
 * 显式登记为不可信的内置工具：网页、邮件、浏览器、附件、文件与命令输出、知识库 / 记忆 / 历史
 * 消息（可能夹带外部内容）、任务与子代理的结果、连接应用。与 {@link TRUSTED_TOOLS} 不相交；
 * 两者之外的名字（MCP / 连接应用的动态工具、未来新增的工具）同样按不可信处理。
 */
export const UNTRUSTED_TOOLS: ReadonlySet<string> = new Set([
  // 插件检索返回市场索引里的文案（外部内容）
  'plugin_search',
  'web_search',
  'web_fetch',
  'mail_list',
  'mail_read',
  'mail_search',
  'get_attachment',
  'understand_image',
  'transcribe_audio',
  'read',
  'ls',
  'find',
  'grep',
  'bash',
  'request_unsandboxed',
  'git_remote',
  'search_messages',
  'get_messages_around',
  'list_my_runs',
  'get_run',
  'get_run_steps',
  'list_tasks',
  'list_todos',
  'list_memos',
  'recall_memory',
  'list_commitments',
  'wiki_search',
  'wiki_read',
  'watch_create',
  'watch_list',
  'delegate_task',
  'collect_delegate_results',
  'widget_craft',
  'widget_read_state',
  'widget_check',
  'widget_template',
  'stage_done',
  'submit_review',
  'install_skill',
  'inspect_bot_assets',
  'capability_search',
  'capability_call',
  'browser_open',
  'browser_snapshot',
  'browser_screenshot',
  'browser_scroll',
  'browser_back',
  'browser_close',
  'browser_click',
  'browser_type',
  'browser_press',
]);

/** 这次工具调用会不会把不可信内容带进本 run：不在可信白名单里的都算（未知工具默认不可信）。 */
export function isUntrustedReadTool(toolName: string): boolean {
  return !TRUSTED_TOOLS.has(toolName);
}

/**
 * 触发批本身带不可信内容（§5.3 第 2 条「附件正文」）：带附件的消息（图片会直接进视觉通道、
 * 其余附件模型可随时读取）——本 run 从一开始就按读过不可信内容处理。
 */
export function triggerCarriesUntrusted(messages: readonly Message[]): boolean {
  return messages.some((message) => message.attachments.length > 0);
}
