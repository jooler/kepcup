/**
 * 生成工具描述的条目清单注入（D124 P3，60 号文档决策 7）：orchestrator 按 Bot
 * 解析条目摘要（`displayName(model)` 清单）传入 imageTools / speechTools 工厂，
 * 三个生成工具（generate_image / generate_speech / generate_video）的描述追加
 * 「本 Bot 可用的 {能力} 模型条目：…」一段。
 *
 * **清单为空（未绑定条目）时不追加任何文案**——描述与今日逐字节一致
 * （media-tools.test.ts 有字符串级断言）。清单 ≤6 条，超出截断为前 6 条 +
 * 「等 N 个」（N = 总数）。
 */

/** 三个生成工具各自的条目名清单（缺省 / 空数组 = 不注入）。 */
export interface MediaEntryHints {
  image?: readonly string[] | undefined;
  tts?: readonly string[] | undefined;
  video?: readonly string[] | undefined;
}

/**
 * Bot 已勾选条目的按能力摘要（`MediaService.entrySummariesFor` 的返回）。orchestrator
 * deps 的 media 是 MediaToolFacade 结构切片，条目摘要以可选方法叠加在真实
 * MediaService 上（精简测试装配的门面没有它 → 不注入，行为不变）。
 */
export type MediaEntrySummaries = { image: string[]; tts: string[]; video: string[] };
export type MediaEntrySummariesFn = (
  botId: string | null | undefined,
) => Promise<MediaEntrySummaries>;

/** 注入清单的条数上限（超出截断并带「等 N 个」）。 */
export const MEDIA_ENTRY_HINT_MAX = 6;

/** 能力 → 分组标题（工具描述与 UI 分组共用一套中文名）。 */
export const ENTRY_CAPABILITY_LABELS: Readonly<
  Record<'image' | 'tts' | 'video', string>
> = {
  image: '图片生成',
  tts: '语音合成',
  video: '视频生成',
};

/**
 * 一段注入文案：「本 Bot 可用的图片生成模型条目：水墨（inkwash-xl）、Qwen-Image；用
 * model 参数指定，留空用默认。」超出 6 条截断为「…、F 等 N 个」。
 */
export function entryHintLine(label: string, names: readonly string[]): string {
  const list =
    names.length > MEDIA_ENTRY_HINT_MAX
      ? `${names.slice(0, MEDIA_ENTRY_HINT_MAX).join('、')} 等 ${names.length} 个`
      : names.join('、');
  return `本 Bot 可用的${label}模型条目：${list}；用 model 参数指定，留空用默认。`;
}

/**
 * 追加注入段（工具描述构建的唯一出口）：清单为空（undefined / 空数组）时原样
 * 返回——保证未绑定条目的 Bot 工具描述与从前逐字节一致。
 */
export function appendEntryHint(
  description: string,
  label: string,
  names: readonly string[] | undefined,
): string {
  if (names === undefined || names.length === 0) return description;
  return `${description}${entryHintLine(label, names)}`;
}
