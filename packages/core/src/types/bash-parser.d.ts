/**
 * bash-parser 0.5.0 ships no types. We only rely on `parse(command)` returning
 * a POSIX shell AST; node shapes are documented in allowlist-match.ts and
 * intentionally loose (unknown nodes fail closed).
 */
declare module 'bash-parser' {
  export interface BashAstNode {
    type: string;
    [key: string]: unknown;
  }
  export default function parse(command: string, options?: Record<string, unknown>): BashAstNode;
}
