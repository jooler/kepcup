/**
 * js-yaml 4 ships no types. Only `load` is used (OpenCode agent frontmatter
 * check, providers/opencode.ts): the default schema, no custom types.
 */
declare module 'js-yaml' {
  export function load(input: string, options?: { filename?: string; json?: boolean }): unknown;
}
