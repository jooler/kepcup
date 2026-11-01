/**
 * Bot 回复的朗读文本提取（docs/design/53-voice-conversation.md「Bot 语音播报
 * 链路」）：markdown → 适合 TTS 朗读的纯文本。纯函数、零依赖，单测锚点。
 *
 * 规则（53 号）：围栏代码块整体跳过（代码不朗读）、行内 code 保留文字、图片
 * 丢弃、链接保留文本、去表格 / 标题 / 引用 / 强调标记；结果 >2000 字按**码点**
 * 截断（Array.from，不截半个多字节字符）——调用方按 `truncated` 每条消息提示
 * 一次「内容过长，已播报前 {limit} 字」（limit = SPEECH_TEXT_LIMIT）。
 *
 * 范围说明：只做 bot 回复常见的 markdown 形态（围栏 / 行内标记 / GFM 表格 /
 * 列表 / 分隔线），不做完整 markdown 解析——残留在文本里的冷门标记交给 TTS
 * 容忍，追求「列表读出来不啰嗦」而不是「零标记残留」。
 */

/** 一次播报的体验上限（53 号；TTS schema 的 50k 上限不设防无意义）。 */
export const SPEECH_TEXT_LIMIT = 2000;

export interface SpeechTextResult {
  /** 提取后的朗读文本（已截断、已 trim）。 */
  text: string;
  /** 超长被截断：调用方 toast 提示（每条消息一次）。 */
  truncated: boolean;
}

/**
 * 围栏代码块（``` / ~~~，含语言标注行）整段跳过；未闭合的围栏剥到结尾。
 * 逐行状态机而非正则，围栏配对按 CommonMark 规则的轻量近似：开栏记录**字符
 * + 完整 run 长度**（`{3,}`，不只认 3 个），闭合须**同字符且 run 长度 ≥ 开栏**
 * ——四反引号包三反引号（LLM 常见输出形态）不会在内部 ``` 处提前闭合、把代码
 * 朗读出来；嵌套 / 语言标注 / 未闭合都稳定。
 */
function stripFencedCodeBlocks(markdown: string): string[] {
  const kept: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of markdown.split('\n')) {
    // 只认行首缩进后的完整 run（CommonMark：开栏可带语言标注）。
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      // 闭合行须**整行**只有 run + 空白（CommonMark：带尾随内容的不算闭合）——
      // `~~~ x` 这类行是栏内内容，误当闭合会提前出栏甚至吞掉后面的正文。
      const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
      const run = close?.[1];
      if (run !== undefined && run[0] === fence.char && run.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (marker !== null) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
      continue;
    }
    kept.push(line);
  }
  return kept;
}

/** 表格分隔行（`| --- | :---: |` 形态：只含 | : - 与空白且确实有横线）。 */
function isTableSeparatorRow(line: string): boolean {
  return line.includes('|') && line.includes('-') && /^[|:\s-]+$/.test(line);
}

/**
 * 行级块标记：标题 / 引用 / 列表 / 表格 / 分隔线。表格保留单元格文字（管道换
 * 空格），其余只剥标记符。
 */
function stripBlockMarkers(line: string): string {
  if (isTableSeparatorRow(line)) return '';
  let out = line;
  // ATX 标题（`#` 起 1-6 级，后跟空白；`#hashtag` 不是标题，不剥）。
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+/, '');
  // 引用（`>` 可叠加：`>>` 剥到内容）。
  out = out.replace(/^[ \t]{0,3}(?:>[ \t]?)+/, '');
  // 列表标记（`-` / `*` / `+` / `1.` / `1)`，后跟空白；行首 `*强调*` 不受影响）。
  out = out.replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/, '');
  // 分隔线（三个及以上的 - / * / _ 组成的整行）。
  if (/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(out)) return '';
  if (out.includes('|')) out = out.split('|').join(' ');
  return out;
}

/** 行内标记：图片丢弃、链接保留文本、行内 code 去反引号、成对强调标记剥除。 */
function stripInlineMarkers(text: string): string {
  let out = text;
  // 图片先于链接处理（否则 `![alt](url)` 会留下 `!alt`）。
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/`([^`]*)`/g, '$1');
  out = out.replace(/(\*\*\*|___)(.+?)\1/g, '$2');
  // 单星 / 双星 / 双下划线强调的词内近似（CommonMark 里 * 允许词内强调，但 TTS
  // 场景 2*3*4 / a**b**c 读成「234」明显更糟）：开栏前且闭栏后**都**是字母数字
  // → 不视为强调标记，原样保留；任一侧贴空白 / 标点的照剥（*斜体* / a*b* c /
  // **粗体** 均正常）。
  out = out.replace(/([\p{L}\p{N}]?)(\*\*|__)(.+?)\2([\p{L}\p{N}]?)/gu, (match, before, mark, inner, after) =>
    before !== '' && after !== '' ? match : before + inner + after,
  );
  // 单星须两侧不贴另一个 *（lookaround）：否则会把上面保留的词内 `**` 当两段
  // 单星配对拆掉（a**b**c 被二次剥成 a*bc）。
  out = out.replace(
    /([\p{L}\p{N}]?)(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)([\p{L}\p{N}]?)/gu,
    (match, before, inner, after) => (before !== '' && after !== '' ? match : before + inner + after),
  );
  out = out.replace(/~~(.+?)~~/g, '$1');
  return out;
}

/** markdown → 朗读文本（截断按码点，不截半个多字节字符）。 */
export function extractSpeechText(markdown: string): SpeechTextResult {
  const lines = stripFencedCodeBlocks(markdown).map(stripBlockMarkers);
  let out = stripInlineMarkers(lines.join('\n'));
  // 空白归一：行首行尾空白（表格管道替换会留）、连续空行、连续空格。
  out = out.replace(/^[ \t]+/gm, '');
  out = out.replace(/[ \t]+$/gm, '');
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/\n{2,}/g, '\n');
  out = out.trim();
  const chars = Array.from(out);
  if (chars.length <= SPEECH_TEXT_LIMIT) return { text: out, truncated: false };
  return { text: chars.slice(0, SPEECH_TEXT_LIMIT).join(''), truncated: true };
}
