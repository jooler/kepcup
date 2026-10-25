/**
 * 草稿失败原因的逐条还原。生成技能的测试脚本按 TAP 风格逐行输出 `ok <项>` /
 * `FAIL <项>`，缩进行是上一条的补充说明，`== 标题 ==` 是分节标题；core 把测试
 * 输出原样存进 bot_skills.status_reason（换行保留，失败前缀拼在首行）。这里
 * 按行解析成检查项供技能详情逐条渲染（绿勾/红叉）；整段里识别不到任何
 * ok/FAIL 行时返回 null，调用方退回整段文本展示（语法检查报错、单句原因等）。
 */
export interface SkillDraftCheck {
  kind: 'pass' | 'fail' | 'info';
  label: string;
}

/** core 拼在测试输出首行的失败前缀（全角/半角冒号都见过），剥离后首行才是第一条检查。 */
const SUMMARY_PREFIXES = ['技能测试未通过：', '技能测试未通过:'];

const MARKER_RE = /^(ok|OK|FAIL|fail)\s+(.+)$/;
/** `== 分节标题 ==`：无勾叉的分隔行，只留标题文字。 */
const HEADER_RE = /^==+\s*(.*?)\s*==+$/;

export function parseSkillDraftChecks(reason: string | null): SkillDraftCheck[] | null {
  if (reason === null || reason.trim().length === 0) return null;
  let text = reason;
  for (const prefix of SUMMARY_PREFIXES) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length);
      break;
    }
  }
  const checks: SkillDraftCheck[] = [];
  let sawMarker = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const marker = MARKER_RE.exec(trimmed);
    if (marker !== null) {
      checks.push({
        kind: marker[1]!.toLowerCase() === 'ok' ? 'pass' : 'fail',
        label: marker[2]!.trim(),
      });
      sawMarker = true;
    } else if (/^\s/.test(line) && checks.length > 0 && checks[checks.length - 1]!.kind !== 'info') {
      // 缩进续行：上一条检查的补充说明，并入其文字（如「缺少: 上一个 tag: v1.0.0」）。
      const last = checks[checks.length - 1]!;
      checks[checks.length - 1] = { ...last, label: `${last.label} ${trimmed}` };
    } else {
      const header = HEADER_RE.exec(trimmed);
      checks.push({ kind: 'info', label: header !== null && header[1]!.length > 0 ? header[1]! : trimmed });
    }
  }
  return sawMarker && checks.length > 0 ? checks : null;
}
