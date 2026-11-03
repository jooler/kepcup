/**
 * KepCup 微应用 SDK 的单一事实来源（设计 55 §6.1，决策 D112）。
 *
 * 微应用的全部能力面——能力闭合枚举、API 方法索引、限额、错误码与作者向 `hint`、
 * MCP Apps 方法映射——只在这一份 TypeScript 数据里维护。垫片 JS、`sdk.md` 入口、
 * `.d.ts` 类型、检查器规则、S2 预览 mock、确认卡能力文案、`micro_app_sdk_inspect`
 * 全部由 `generate.ts` 从这里生成 / 读取，不另写第二份（仓库「设置目录」同构）。
 *
 * 约束（55 §6.2，生成物与守卫测试共同遵守）：
 * - 全部异步能力返回 Promise，错误带 `code`；`hint` 给写代码的 Bot（哪次调用、期望
 *   什么、下一步改什么），不进用户界面。
 * - 能力协商优于错误探测：`app.ready()` 的 `capabilities` / `grants` 是唯一依据。
 * - 不暴露 resourceId、宿主路径、模型 id；`hint` 里同样不出现。
 */

/** 清单 `spec` 字段的当前值；未知值一律拒绝交付（不静默忽略）。 */
export const MICRO_APP_SPEC_VERSION = 'kepcup-micro-app/1';

/** 微应用垫片的指纹（幂等判定与注入成功确认都认它）。 */
export const MICRO_APP_SDK_MARKER = 'kepcup-micro-app-sdk-v1';

/** 桥 v2 的来源标记（55 §6.3：帧带 `k` 判别，来源仍以 `event.source` 为唯一防线）。 */
export const MICRO_APP_BRIDGE_APP_SOURCE = 'kepcup-micro-app';
export const MICRO_APP_BRIDGE_HOST_SOURCE = 'kepcup-micro-host';

// --- 能力闭合枚举（55 §5.1）-----------------------------------------------------

/** 能力引入的阶段；清单校验按「当前运行时已实现集合」拒绝未到位的声明并如实回执。 */
export type MicroAppCapabilityPhase = 'P0' | 'P1' | 'P2' | 'P3';

/** 授权档（55 §5.1 表的第 3 列）：免审 / 打开时确认 / 每次运行会话授权 / 每次调用确认 / 用户手势。 */
export type MicroAppCapabilityGrant = 'free' | 'open-confirm' | 'session' | 'each-call' | 'gesture';

export interface MicroAppCapabilitySpec {
  /** 闭合枚举里的能力 id；`net.fetch` 不在其中（由 `net.mode` 表达，默认开放）。 */
  readonly id: string;
  /** 短名（管理页 / 检查器引用）。 */
  readonly title: string;
  /** 确认卡上的一行人话（55 §5.2「它能做什么」清单的条目文案）。 */
  readonly userLine: string;
  /** 给作者的说明（sdk.md / references 用）。 */
  readonly summary: string;
  readonly grant: MicroAppCapabilityGrant;
  readonly phase: MicroAppCapabilityPhase;
  /** 限额的人话描述（确认卡与 references 共用）。 */
  readonly limits: string;
  /** 该能力打开的桥方法（`platform` 方法不在此列）。 */
  readonly api: readonly string[];
}

export const MICRO_APP_CAPABILITIES: readonly MicroAppCapabilitySpec[] = [
  {
    id: 'storage.kv',
    title: '键值存储',
    userLine: '保存数据（本机，仅此微应用）',
    summary: '微应用私有的 KV（`widget_docs`，命名空间 = 微应用 id），跨会话保留，可清空。',
    grant: 'free',
    phase: 'P0',
    limits: '总量 1MB / 1000 键 / 单值 256KB；与查询合计限流（突发 20、每秒 5、在途 20）',
    api: ['storage.get', 'storage.set', 'storage.delete', 'storage.list'],
  },
  {
    id: 'storage.collection',
    title: '结构化集合',
    userLine: '保存结构化数据（本机，仅此微应用）',
    summary: '文档集合（主键 + 简单索引），适合记录列表与进度明细。',
    grant: 'free',
    phase: 'P2',
    limits: '总量 5MB / 10 个集合',
    api: ['collections.put', 'collections.get', 'collections.delete', 'collections.list', 'collections.query'],
  },
  {
    id: 'ai.chat',
    title: '模型调用',
    userLine: '调用模型生成对话（计入编写此微应用的 Bot 的模型额度）',
    summary: '微应用私有的多轮模型会话；上下文不进主对话，无工具面，模型由宿主策略决定。',
    grant: 'open-confirm',
    phase: 'P1',
    limits: '每会话 / 每微应用每日 / 每 Bot 每日三级 token 预算；并发 1',
    api: ['ai.chat', 'ai.session.create', 'ai.session.send', 'ai.session.history', 'ai.session.reset'],
  },
  {
    id: 'media.listen',
    title: '麦克风听写',
    userLine: '使用麦克风听你说话（录音只用于转写，不保存）',
    summary: '宿主代理采集 + VAD 分段 + ASR；微应用只拿到文本、电平与状态，原始音频不出宿主。',
    grant: 'session',
    phase: 'P1',
    limits: '单段 1.5–15s；每次运行会话授权，关闭即释放',
    api: ['media.listen'],
  },
  {
    id: 'media.speak',
    title: '语音播报',
    userLine: '播放语音',
    summary: '宿主侧 TTS 合成与播放（队列可打断）；防止回声，播报时暂停采集。',
    grant: 'free',
    phase: 'P1',
    limits: '队列 ≤3 段；可随时打断',
    api: ['media.speak', 'media.stopSpeaking'],
  },
  {
    id: 'host.reply',
    title: '回传对话',
    userLine: '以你的名义把内容发进对话（每次都会先请你确认）',
    summary: '用户可见的一条消息；只能在用户手势里调用，宿主出确认条。',
    grant: 'each-call',
    phase: 'P0',
    limits: '≤2000 字；每卡冷却 5s；确认条单例',
    api: ['reply'],
  },
  {
    id: 'host.openLink',
    title: '打开链接',
    userLine: '打开网页链接（每次都会先请你确认）',
    summary: 'https 外链经宿主打开；卡内确认条 + 冷却。',
    grant: 'each-call',
    phase: 'P0',
    limits: '仅 https；每次确认；拒绝后冷却 5s',
    api: ['openLink'],
  },
  {
    id: 'context.update',
    title: '同步进度摘要',
    userLine: '把学习进度摘要同步给对话（不产生消息，可随时清除）',
    summary: '结构化摘要（headline ≤80 字 + data ≤1KB）进主对话下一轮；last-wins。',
    grant: 'open-confirm',
    phase: 'P2',
    limits: 'headline ≤80 字、data ≤1KB；last-wins；仅用户手势或暂停 / 关闭时接受',
    api: ['context.update', 'context.clear'],
  },
  {
    id: 'files.pick',
    title: '选择文件',
    userLine: '让你选择一个文件供它读取（只读副本）',
    summary: '系统选择器 + 用户手势；只读副本句柄。',
    grant: 'gesture',
    phase: 'P3',
    limits: '单文件 20MB',
    api: ['files.pick'],
  },
  {
    id: 'notify',
    title: '系统通知',
    userLine: '发送系统通知',
    summary: '需用户开总闸的系统通知。',
    grant: 'free',
    phase: 'P3',
    limits: '每 10 分钟 1 条',
    api: ['notify'],
  },
];

export const MICRO_APP_CAPABILITY_IDS: readonly string[] = MICRO_APP_CAPABILITIES.map((c) => c.id);

export function microAppCapabilityOf(id: string): MicroAppCapabilitySpec | undefined {
  return MICRO_APP_CAPABILITIES.find((c) => c.id === id);
}

/**
 * 当前运行时**已实现**的能力集合（清单声明据此裁决：声明了未实现的能力 → 交付拒绝，
 * 回执如实写明，而不是发一张永远打不开的卡）。随 P1 / P2 / P3 落地逐阶段扩大。
 */
export const MICRO_APP_IMPLEMENTED_CAPABILITIES: readonly string[] = ['storage.kv', 'host.reply', 'host.openLink'];

/**
 * 当前运行时所处的阶段（平台面方法按它裁决是否已在白名单里）。落地一个阶段时把它
 * 前移一格，并同步扩充 {@link MICRO_APP_IMPLEMENTED_CAPABILITIES}——两个常量是
 * 「本阶段已实现」的唯一开关，守卫测试锁它们的一致性。
 */
export const MICRO_APP_RUNTIME_PHASE: MicroAppCapabilityPhase = 'P0';

// --- API 方法索引（垫片 / d.ts / sdk.md / 检查器 / inspect 共用）-------------------

export interface MicroAppApiMethodSpec {
  /** 桥方法名（`app.ready` 这类 `app.*` / `ui.*` 是平台面，不属于任何能力）。 */
  readonly method: string;
  /** 所属能力 id，或 `'platform'`（总是可用，不需要声明）。 */
  readonly capability: string | 'platform';
  /** 一行签名（sdk.md 入口用）。 */
  readonly signature: string;
  /** 参数 / 返回的形状说明（references 与 inspect 用）。 */
  readonly params: string;
  readonly returns: string;
  readonly since: MicroAppCapabilityPhase;
  readonly deprecated?: boolean;
}

export const MICRO_APP_API_METHODS: readonly MicroAppApiMethodSpec[] = [
  {
    method: 'app.ready',
    capability: 'platform',
    signature: 'kepcup.app.ready(): Promise<ReadyInfo>',
    params: '无',
    returns: '{ capabilities: string[]; grants: { mic: granted|denied|unavailable; net: { mode; domains } }; theme; displayMode; viewport; instanceId }',
    since: 'P0',
  },
  {
    method: 'app.on',
    capability: 'platform',
    signature: "kepcup.app.on(event, cb): () => void",
    params: "event: 'theme' | 'pause' | 'resume' | 'capability.revoked' | 'display-mode'",
    returns: '取消订阅函数',
    since: 'P0',
  },
  {
    method: 'app.setTitle',
    capability: 'platform',
    signature: 'kepcup.app.setTitle(title: string): void',
    params: 'title: 外壳标题栏显示的标题（≤120 字）',
    returns: '无（通知）',
    since: 'P0',
  },
  {
    method: 'app.requestDisplayMode',
    capability: 'platform',
    signature: "kepcup.app.requestDisplayMode(mode: 'inline'|'immersive'): Promise<{ mode }>",
    params: 'mode: 请求的展示模式（经外壳，不直接改窗口）',
    returns: '{ mode }（实际生效值）',
    since: 'P1',
  },
  {
    method: 'app.close',
    capability: 'platform',
    signature: 'kepcup.app.close(): void',
    params: '无',
    returns: '无（请求宿主关闭本实例）',
    since: 'P1',
  },
  {
    method: 'storage.get',
    capability: 'storage.kv',
    signature: 'kepcup.storage.get(key): Promise<unknown>',
    params: 'key: string（≤200 字）',
    returns: '存的值（JSON），不存在为 undefined',
    since: 'P0',
  },
  {
    method: 'storage.set',
    capability: 'storage.kv',
    signature: 'kepcup.storage.set(key, value): Promise<void>',
    params: 'key: string；value: 任意 JSON 值（序列化 ≤256KB）',
    returns: 'void',
    since: 'P0',
  },
  {
    method: 'storage.delete',
    capability: 'storage.kv',
    signature: 'kepcup.storage.delete(key): Promise<void>',
    params: 'key: string',
    returns: 'void',
    since: 'P0',
  },
  {
    method: 'storage.list',
    capability: 'storage.kv',
    signature: 'kepcup.storage.list(): Promise<string[]>',
    params: '无',
    returns: '全部键（排序不保证）',
    since: 'P0',
  },
  {
    method: 'query',
    capability: 'platform',
    signature: 'kepcup.query(name, params?, opts?): Promise<{ rows; truncated; nextCursor? }>',
    params: 'name: 随版本预审的查询模板名；params: JSON 标量；opts: { cursor?, maxBytes? }（P2）',
    returns: '行数组（≤200 行 / 1MB，超出标记 truncated）',
    since: 'P0',
  },
  {
    method: 'openLink',
    capability: 'host.openLink',
    signature: 'kepcup.openLink(url): Promise<void>',
    params: 'url: https 链接',
    returns: 'void（用户确认后打开；拒绝抛错）',
    since: 'P0',
  },
  {
    method: 'reply',
    capability: 'host.reply',
    signature: 'kepcup.reply(text): Promise<boolean>',
    params: 'text: ≤2000 字；必须在用户手势里调用',
    returns: '是否发出（无手势 / 用户取消 / 冷却中为 false，不抛错）',
    since: 'P0',
  },
  {
    method: 'ui.theme',
    capability: 'platform',
    signature: "kepcup.ui.theme(): Promise<'light'|'dark'>",
    params: '无',
    returns: "当前主题（变更经 app.on('theme') 推送）",
    since: 'P0',
  },
  {
    method: 'ai.chat',
    capability: 'ai.chat',
    signature: 'kepcup.ai.chat(input): Promise<{ text }> | AsyncIterable<{ delta }>',
    params: "input: { messages: {role,content}[]; stream?: boolean }（system 会包 <untrusted> 边界）",
    returns: 'stream 时为 AsyncIterable<{ delta }>，否则 { text }',
    since: 'P1',
  },
  {
    method: 'ai.session.create',
    capability: 'ai.chat',
    signature: 'kepcup.ai.session(input): Promise<Session>',
    params: 'input: { id?; system?; maxTurns? }',
    returns: '{ send(text, {stream? }); history(); reset() }',
    since: 'P1',
  },
  {
    method: 'ai.session.send',
    capability: 'ai.chat',
    signature: 'session.send(text, { stream }): Promise<{ text }> | AsyncIterable<{ delta }>',
    params: 'text: 用户侧输入；stream: 流式',
    returns: '同 ai.chat',
    since: 'P1',
  },
  {
    method: 'ai.session.history',
    capability: 'ai.chat',
    signature: 'session.history(): Promise<{ role; content }[]>',
    params: '无',
    returns: '本会话历史（微应用私有，不进主对话）',
    since: 'P1',
  },
  {
    method: 'ai.session.reset',
    capability: 'ai.chat',
    signature: 'session.reset(): Promise<void>',
    params: '无',
    returns: 'void（清空会话历史）',
    since: 'P1',
  },
  {
    method: 'media.listen',
    capability: 'media.listen',
    signature: "kepcup.media.listen(input?): Promise<Listener>",
    params: "input: { lang?; mode: 'push-to-talk'|'vad'; silenceMs? }",
    returns: "{ start(); stop(); on(event, cb) }，事件：level / speech-start / partial / final / error / end",
    since: 'P1',
  },
  {
    method: 'media.speak',
    capability: 'media.speak',
    signature: 'kepcup.media.speak(input): Promise<void>',
    params: 'input: { text; voice?; rate? }',
    returns: 'void（入队播放，完成后 resolve）',
    since: 'P1',
  },
  {
    method: 'media.stopSpeaking',
    capability: 'media.speak',
    signature: 'kepcup.media.stopSpeaking(): Promise<void>',
    params: '无',
    returns: 'void（立即停播并清队列）',
    since: 'P1',
  },
  {
    method: 'context.update',
    capability: 'context.update',
    signature: 'kepcup.context.update(summary): Promise<void>',
    params: 'summary: { headline: ≤80 字; data?: JSON ≤1KB }（不接受自由文本数组）',
    returns: 'void（last-wins；仅用户手势或 pause/close 时接受）',
    since: 'P2',
  },
  {
    method: 'context.clear',
    capability: 'context.update',
    signature: 'kepcup.context.clear(): Promise<void>',
    params: '无',
    returns: 'void（清除当前摘要）',
    since: 'P2',
  },
  {
    method: 'collections.put',
    capability: 'storage.collection',
    signature: 'kepcup.collections.put(name, doc): Promise<void>',
    params: 'name: 集合名；doc: { id, ... }',
    returns: 'void',
    since: 'P2',
  },
  {
    method: 'collections.get',
    capability: 'storage.collection',
    signature: 'kepcup.collections.get(name, id): Promise<unknown>',
    params: 'name; id',
    returns: '文档（不存在为 undefined）',
    since: 'P2',
  },
  {
    method: 'collections.delete',
    capability: 'storage.collection',
    signature: 'kepcup.collections.delete(name, id): Promise<void>',
    params: 'name; id',
    returns: 'void',
    since: 'P2',
  },
  {
    method: 'collections.list',
    capability: 'storage.collection',
    signature: 'kepcup.collections.list(name): Promise<unknown[]>',
    params: 'name',
    returns: '集合内全部文档',
    since: 'P2',
  },
  {
    method: 'collections.query',
    capability: 'storage.collection',
    signature: 'kepcup.collections.query(name, filter): Promise<unknown[]>',
    params: "name; filter: { where?: { field, op, value }[]; limit? }",
    returns: '匹配的文档',
    since: 'P2',
  },
  {
    method: 'files.pick',
    capability: 'files.pick',
    signature: 'kepcup.files.pick(input): Promise<PickedFile>',
    params: 'input: { accept?: string[] }',
    returns: '{ name; mime; bytes; read(): Promise<ArrayBuffer> }（只读副本）',
    since: 'P3',
  },
  {
    method: 'notify',
    capability: 'notify',
    signature: 'kepcup.notify(input): Promise<void>',
    params: 'input: { title; body }',
    returns: 'void（需用户总闸；每 10 分钟 1 条）',
    since: 'P3',
  },
];

export function microAppApiMethodOf(method: string): MicroAppApiMethodSpec | undefined {
  return MICRO_APP_API_METHODS.find((m) => m.method === method);
}

// --- 错误契约：code + 作者向 hint 同源（55 §6.2 / §6.3）---------------------------

export interface MicroAppErrorHintSpec {
  readonly code: string;
  /** 给写这段代码的 Bot 的修复提示：点名哪次调用、期望什么、下一步改什么。 */
  readonly hint: string;
}

export const MICRO_APP_ERROR_HINTS: readonly MicroAppErrorHintSpec[] = [
  {
    code: 'MICRO_APP_MANIFEST_INVALID',
    hint: 'micro-app.json 没通过校验：检查报错点名的字段（spec / permissions / net / entry），未知能力或未知字段都会被拒绝；对照 references/manifest.md 的示例改一版再交付。',
  },
  {
    code: 'MICRO_APP_UNSUPPORTED_SPEC',
    hint: '清单的 spec 版本当前 KepCup 不认识：把 spec 改为 kepcup-micro-app/1，或让用户升级 KepCup。',
  },
  {
    code: 'MICRO_APP_CAPABILITY_NOT_DECLARED',
    hint: '这次调用的能力不在 micro-app.json 的 permissions 里：要么在清单里声明它（会触发用户重新确认），要么改用已声明的能力；不要靠反复调用试探。',
  },
  {
    code: 'MICRO_APP_CAPABILITY_DENIED',
    hint: '用户在本运行会话拒绝了这个能力（或已撤销）：用 app.ready() 的 grants/capabilities 看当前状态，按返回值降级（如麦克风 → 键盘输入），不要重试。',
  },
  {
    code: 'MICRO_APP_CAPABILITY_NOT_CONFIGURED',
    hint: '宿主缺少这个能力的配置（如 ASR/TTS/模型未设置）：引导用户走设置深链，同时准备无该能力的降级路径——这是验收点。',
  },
  {
    code: 'MICRO_APP_AI_QUOTA',
    hint: '模型用量超出预算（会话 / 每日 / Bot 三级之一）：提示用户本次进度已保存，减少轮次或等预算恢复；不要自动重试。',
  },
  {
    code: 'MICRO_APP_AI_BUSY',
    hint: '本实例已有一个模型调用在途（并发 1）：等上一个 Promise 结束再发下一个，不要并行调用。',
  },
  {
    code: 'MICRO_APP_AI_UNAVAILABLE',
    hint: '模型暂时不可用（厂商错误 / 未配置）：显示可读错误并保留进度（先写 storage 再提示），不要白屏。',
  },
];

export function microAppErrorHintOf(code: string): string | undefined {
  return MICRO_APP_ERROR_HINTS.find((e) => e.code === code)?.hint;
}

// --- MCP Apps 机械映射（55 §6.3：不依赖该协议，只为将来导出省一次翻译）------------

/** kepcup 桥方法 → MCP Apps（SEP-1865）`ui/*` 名。映射表随 spec 生成，不手工维护。 */
export const MICRO_APP_MCP_APPS_METHOD_MAP: Readonly<Record<string, string>> = {
  openLink: 'ui/open-link',
  reply: 'ui/message',
  'app.requestDisplayMode': 'ui/request-display-mode',
  'context.update': 'ui/update-model-context',
  setHeight: 'ui/notifications/size-changed',
};

// --- 限额与桥协议常量（55 §5.1 / §6.3 / §8.3）-------------------------------------

/** 每微应用每事件通道的订阅上限（桥 v2）。 */
export const MICRO_APP_EVENT_SUBSCRIPTIONS_MAX = 32;
/** 未确认事件窗口：宿主侧超过即停发并断开，微应用侧重连（seq 缺口同样断开）。 */
export const MICRO_APP_EVENT_WINDOW_MAX = 64;
/** 桥 v2 单帧 JSON 序列化的字符上限（同 v1：KV 单值 ≤256KB 留转义余量）。 */
export const MICRO_APP_BRIDGE_MESSAGE_MAX_CHARS = 1024 * 1024;
/** 清单 `ai.maxTokensPerSession` 的宿主夹取上限（55 §8.3）。 */
export const MICRO_APP_TOKENS_PER_SESSION_MAX = 50_000;
/** 微应用展示模式的枚举。 */
export const MICRO_APP_DISPLAY_MODES = ['inline', 'immersive'] as const;
export type MicroAppDisplayMode = (typeof MICRO_APP_DISPLAY_MODES)[number];
