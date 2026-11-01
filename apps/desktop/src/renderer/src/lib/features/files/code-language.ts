import { extensionOf } from './artifact-kind';

/**
 * 代码档（`ArtifactKind = 'code'`）的扩展名 → shiki 语言映射。
 *
 * 纯函数、无依赖：既给 CodeViewer 用（决定高亮语言），也给测试直接用。
 * `id` 必须是 shiki 内置语言 id（`shiki/langs/<id>.mjs`）；`label` 只用于界面
 * 上的语言名。未知扩展返回 `null`，调用方退化为纯文本。
 */
export interface CodeLanguage {
  id: string;
  label: string;
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, CodeLanguage>> = {
  '.ts': { id: 'typescript', label: 'TypeScript' },
  '.mts': { id: 'typescript', label: 'TypeScript' },
  '.cts': { id: 'typescript', label: 'TypeScript' },
  '.tsx': { id: 'tsx', label: 'TSX' },
  '.js': { id: 'javascript', label: 'JavaScript' },
  '.mjs': { id: 'javascript', label: 'JavaScript' },
  '.cjs': { id: 'javascript', label: 'JavaScript' },
  '.jsx': { id: 'jsx', label: 'JSX' },
  '.svelte': { id: 'svelte', label: 'Svelte' },
  '.vue': { id: 'vue', label: 'Vue' },
  '.json': { id: 'json', label: 'JSON' },
  '.jsonc': { id: 'jsonc', label: 'JSONC' },
  '.yaml': { id: 'yaml', label: 'YAML' },
  '.yml': { id: 'yaml', label: 'YAML' },
  '.toml': { id: 'toml', label: 'TOML' },
  '.xml': { id: 'xml', label: 'XML' },
  '.ini': { id: 'ini', label: 'INI' },
  '.css': { id: 'css', label: 'CSS' },
  '.scss': { id: 'scss', label: 'SCSS' },
  '.sass': { id: 'sass', label: 'Sass' },
  '.less': { id: 'less', label: 'Less' },
  '.py': { id: 'python', label: 'Python' },
  '.rb': { id: 'ruby', label: 'Ruby' },
  '.go': { id: 'go', label: 'Go' },
  '.rs': { id: 'rust', label: 'Rust' },
  '.java': { id: 'java', label: 'Java' },
  '.kt': { id: 'kotlin', label: 'Kotlin' },
  '.swift': { id: 'swift', label: 'Swift' },
  '.php': { id: 'php', label: 'PHP' },
  '.lua': { id: 'lua', label: 'Lua' },
  '.dart': { id: 'dart', label: 'Dart' },
  '.cs': { id: 'csharp', label: 'C#' },
  '.c': { id: 'c', label: 'C' },
  '.h': { id: 'c', label: 'C' },
  '.cpp': { id: 'cpp', label: 'C++' },
  '.hpp': { id: 'cpp', label: 'C++' },
  '.cc': { id: 'cpp', label: 'C++' },
  '.sh': { id: 'bash', label: 'Bash' },
  '.bash': { id: 'bash', label: 'Bash' },
  '.zsh': { id: 'bash', label: 'Bash' },
  '.sql': { id: 'sql', label: 'SQL' },
};

/** 扩展名（大小写不敏感）→ 高亮语言；未知扩展返回 `null`。 */
export function codeLanguageOf(filePath: string): CodeLanguage | null {
  return LANGUAGE_BY_EXTENSION[extensionOf(filePath)] ?? null;
}
