import { z } from 'zod';

/**
 * 计算机操控（D105，docs/design/52-computer-use.md）的运行时契约。
 *
 * 裁剪自 stablyai/orca @ 55507b87 的 `src/shared/computer-use-runtime-types.ts`
 * （路径映射见 `apps/desktop/native/NOTICE.md`）：main 的编排层
 * （apps/desktop/src/main/computer/，移植自 orca `src/main/computer/`）与 core 的
 * `computer_*` 工具经 B 口 birpc 交换这些结构；sidecar 方法面（capabilities /
 * listApps / … / setValue）与设计 §4 的工具表一对一。
 *
 * 关键语义（不可简化，执行文档「风险与注意」3）：
 * - `ComputerActionVerification` 的 `unverified`（可能已下发）在工具层映射为
 *   `ToolResult.outcome: 'uncertain'`，重试前必须先观察；
 * - 错误码枚举是 helper / provider 的原样透传面（`RuntimeClientError.code`），
 *   工具层只补人话引导，不改写 code。
 */

/** helper / provider 的错误码（main 侧 RuntimeClientError 原样透传）。 */
export const computerErrorCodeSchema = z.enum([
  'app_not_found',
  'app_blocked',
  'window_not_found',
  'window_not_focused',
  'background_unavailable',
  'window_stale',
  'provider_incompatible',
  'unsupported_capability',
  'permission_denied',
  'element_not_found',
  'element_not_clickable',
  'action_not_supported',
  'value_not_settable',
  'invalid_argument',
  'action_timeout',
  'verification_failed',
  'screenshot_failed',
  'accessibility_error',
]);
export type ComputerErrorCode = z.infer<typeof computerErrorCodeSchema>;

/**
 * 应用寻址：精确名（`localizedName`，如 "Notes"）或 bundle id（`com.apple.Notes`）。
 * 先 `listApps` 看名字——名称跟随系统语言（本机英文系统里「备忘录」是 "Notes"）。
 */
export type ComputerAppQuery = string;

export const computerAppInfoSchema = z.object({
  name: z.string(),
  bundleId: z.string().nullable(),
  pid: z.number().int(),
});
export type ComputerAppInfo = z.infer<typeof computerAppInfoSchema>;

export const computerWindowInfoSchema = z.object({
  id: z.number().int().nullable().optional(),
  index: z.number().int().nullable().optional(),
  title: z.string(),
  x: z.number().nullable().optional(),
  y: z.number().nullable().optional(),
  width: z.number(),
  height: z.number(),
  isMinimized: z.boolean().nullable().optional(),
  isOffscreen: z.boolean().nullable().optional(),
  screenIndex: z.number().int().nullable().optional(),
  /** 平台私有字段（macOS：window layer / alpha 等），透传不解释。 */
  platform: z.record(z.string(), z.unknown()).optional(),
});
export type ComputerWindowInfo = z.infer<typeof computerWindowInfoSchema>;

/**
 * 一次观察的快照：紧凑树文本（元素索引在行首；大树按优先级裁剪、索引可跳号）。
 * `treeDiff` 仅在树文本是对同窗口上一快照的增量 diff 时出现（sidecar 进程内持基线）。
 */
export const computerSnapshotDataSchema = z.object({
  id: z.string(),
  app: computerAppInfoSchema,
  window: computerWindowInfoSchema,
  coordinateSpace: z.literal('window'),
  treeText: z.string(),
  elementCount: z.number().int(),
  focusedElementId: z.number().int().nullable(),
  treeDiff: z
    .object({
      baseSnapshotId: z.string(),
      changed: z.number().int(),
      added: z.number().int(),
      removed: z.number().int(),
    })
    .optional(),
  truncation: z
    .object({
      truncated: z.boolean(),
      maxNodes: z.number().int().optional(),
      maxDepth: z.number().int().optional(),
      maxDepthReached: z.boolean().optional(),
    })
    .optional(),
});
export type ComputerSnapshotData = z.infer<typeof computerSnapshotDataSchema>;

/** 截屏（base64 PNG；进 `ToolResult.images`，模型无图像能力时按惯例降级为文字说明）。 */
export const computerScreenshotDataSchema = z.object({
  data: z.string().optional(),
  format: z.literal('png'),
  width: z.number().int(),
  height: z.number().int(),
  scale: z.number(),
});
export type ComputerScreenshotData = z.infer<typeof computerScreenshotDataSchema>;

export const computerScreenshotMetadataSchema = z.object({
  engine: z.enum(['screenCaptureKit', 'cgWindowList', 'unknown']).optional(),
  windowId: z.number().int().nullable().optional(),
});
export type ComputerScreenshotMetadata = z.infer<typeof computerScreenshotMetadataSchema>;

export const computerScreenshotStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('captured'), metadata: computerScreenshotMetadataSchema.optional() }),
  z.object({ state: z.literal('skipped'), reason: z.literal('no_screenshot_flag') }),
  z.object({
    state: z.literal('failed'),
    code: computerErrorCodeSchema,
    message: z.string(),
    metadata: computerScreenshotMetadataSchema.optional(),
  }),
]);
export type ComputerScreenshotStatus = z.infer<typeof computerScreenshotStatusSchema>;

/**
 * 动作投递元数据：`path` 是实际生效的通道（accessibility 优先，synthetic 键鼠 /
 * clipboard 兜底）；`delivery` 区分后台（不抢焦点，默认）与前台（`restore_window`）。
 */
export const computerActionMetadataSchema = z.object({
  path: z.enum(['accessibility', 'synthetic', 'clipboard']),
  actionName: z.string().nullable().optional(),
  fallbackReason: z.string().nullable().optional(),
  targetWindowId: z.number().int().nullable().optional(),
  targetWindowIndex: z.number().int().nullable().optional(),
  delivery: z.enum(['background', 'foreground']).optional(),
  verification: z.lazy(() => computerActionVerificationSchema).optional(),
});
export type ComputerActionMetadata = z.infer<typeof computerActionMetadataSchema>;

/**
 * 防重放验证（orca / ZCode 事故验证过的语义，**不得简化**）：
 * - `verified`：动作效果读回确认；
 * - `unverified`：动作**可能已下发**（synthetic 输入、剪贴板粘贴、读回不支持、
 *   疑似空操作等）——工具层映射 `outcome: 'uncertain'`，结果文本明示
 *   「先观察再决定重试」，引擎不得盲目重试。
 */
export const computerActionVerificationSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('verified'),
    property: z.enum(['focusedText', 'selection', 'value']),
    expected: z.string().nullable().optional(),
    actualPreview: z.string().nullable().optional(),
  }),
  z.object({
    state: z.literal('unverified'),
    reason: z.enum([
      'synthetic_input',
      'clipboard_paste',
      'accessibility_action_unasserted',
      'provider_unavailable',
      'readback_unsupported',
      'window_changed',
      'value_mismatch',
      'suspected_noop',
    ]),
    expected: z.string().nullable().optional(),
    actualPreview: z.string().nullable().optional(),
  }),
]);
export type ComputerActionVerification = z.infer<typeof computerActionVerificationSchema>;

export const computerSnapshotResultSchema = z.object({
  snapshot: computerSnapshotDataSchema,
  screenshot: computerScreenshotDataSchema.nullable(),
  screenshotStatus: computerScreenshotStatusSchema,
});
export type ComputerSnapshotResult = z.infer<typeof computerSnapshotResultSchema>;

export const computerActionResultSchema = computerSnapshotResultSchema.extend({
  action: computerActionMetadataSchema.optional(),
});
export type ComputerActionResult = z.infer<typeof computerActionResultSchema>;

/** provider 握手能力（helper `handshake` 结果；platform 为 provider 所在平台）。 */
export const computerProviderCapabilitiesSchema = z.object({
  platform: z.enum(['darwin', 'win32', 'linux']),
  provider: z.string(),
  providerVersion: z.string(),
  protocolVersion: z.number().int(),
  supports: z.object({
    apps: z.object({
      list: z.boolean(),
      bundleIds: z.boolean(),
      pids: z.boolean(),
    }),
    windows: z.object({
      list: z.boolean(),
      targetById: z.boolean(),
      targetByIndex: z.boolean(),
      focus: z.boolean(),
      moveResize: z.boolean(),
    }),
    observation: z.object({
      screenshot: z.boolean(),
      annotatedScreenshot: z.boolean(),
      elementFrames: z.boolean(),
      ocr: z.boolean(),
      treeDiff: z.boolean().optional(),
    }),
    actions: z.object({
      click: z.boolean(),
      typeText: z.boolean(),
      pressKey: z.boolean(),
      hotkey: z.boolean(),
      pasteText: z.boolean(),
      scroll: z.boolean(),
      drag: z.boolean(),
      setValue: z.boolean(),
      performAction: z.boolean(),
    }),
    surfaces: z.object({
      menus: z.boolean(),
      dialogs: z.boolean(),
      dock: z.boolean(),
      menubar: z.boolean(),
    }),
    input: z.object({ background: z.boolean() }).optional(),
  }),
});
export type ComputerProviderCapabilities = z.infer<typeof computerProviderCapabilitiesSchema>;

export const computerWindowListWindowSchema = computerWindowInfoSchema.extend({
  app: computerAppInfoSchema,
  index: z.number().int(),
  isMain: z.boolean().nullable().optional(),
});
export type ComputerWindowListWindow = z.infer<typeof computerWindowListWindowSchema>;

export const computerListWindowsResultSchema = z.object({
  app: computerAppInfoSchema,
  windows: z.array(computerWindowListWindowSchema),
});
export type ComputerListWindowsResult = z.infer<typeof computerListWindowsResultSchema>;

export const computerListAppsResultSchema = z.object({
  apps: z.array(
    computerAppInfoSchema.extend({
      isRunning: z.boolean(),
      lastUsedAt: z.string().nullable(),
      useCount: z.number().int().nullable(),
    }),
  ),
});
export type ComputerListAppsResult = z.infer<typeof computerListAppsResultSchema>;

/**
 * B 口 `computer.invoke` 的方法白名单（= sidecar 方法面，设计 §3；orca 的
 * `selectText` 未实现不暴露）。main 侧注册处与 core 工具层都以它为准。
 */
export const COMPUTER_INVOKE_METHODS = [
  'capabilities',
  'listApps',
  'listWindows',
  'getAppState',
  'click',
  'performSecondaryAction',
  'scroll',
  'drag',
  'typeText',
  'pressKey',
  'hotkey',
  'pasteText',
  'setValue',
] as const;
export type ComputerInvokeMethod = (typeof COMPUTER_INVOKE_METHODS)[number];
