/** scripts/build-share-extension.mjs 的类型（测试 import 用；脚本是纯 JS）。 */
export const SHARE_GROUP_PLIST_KEY: string;
export function expandedEntitlements(raw: string, team: string | null): string;
export function entitlementGroupId(team: string | null): string | null;
export function injectGroupIdIntoPlist(plistPath: string, groupId: string): void;
