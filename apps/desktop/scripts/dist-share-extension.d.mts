/** scripts/dist-share-extension.mjs 的类型（测试 import 用；脚本是纯 JS）。 */
export function macTargetArchesFromYml(raw: string): string[];
export function macTargetArches(builderArgs: string[], ymlArches: string[]): string[];
export function shareExtensionSkipPlan(input: {
  arches: string[];
  appexExists: (arch: string) => boolean;
}): { skip: boolean; missing: string[] };
