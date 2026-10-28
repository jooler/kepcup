import { describe, expect, it } from 'vitest';
import { BUILTIN_AGENT_RUNTIME, type BotProfile } from '@kepcup/shared';
import { effectivePluginIds } from '../../src/plugins/effective.js';

/**
 * P2 注入模型的唯一集计算（todo/plugin-platform/P2-injection.md §3.1）：
 * `runtime.plugin_ids ∪ project_plugins`；缺失 / 空的两边都得出空集。
 */

function profile(pluginIds?: string[]): Pick<BotProfile, 'runtime'> {
  return {
    runtime: {
      model: '',
      light_model: '',
      network_policy: 'open',
      network_allowlist: [],
      mcp_server_ids: [],
      app_connection_ids: [],
      browser_profile: '',
      message_transport: '',
      inkcop_agent_keys: [],
      ...(pluginIds !== undefined ? { plugin_ids: pluginIds } : {}),
      agent: { ...BUILTIN_AGENT_RUNTIME },
    },
  };
}

describe('effectivePluginIds (P2 注入模型)', () => {
  it('两边都缺省 = 空集（未启用任何插件）', () => {
    expect(effectivePluginIds(profile())).toEqual(new Set());
    expect(effectivePluginIds(profile(undefined), [])).toEqual(new Set());
  });

  it('并集：Bot 自己启用 ∪ 项目叠加，重复 id 只留一份', () => {
    expect(effectivePluginIds(profile(['a', 'b']), ['b', 'c'])).toEqual(
      new Set(['a', 'b', 'c']),
    );
  });

  it('只有一边时照常工作（私聊会话 / 成员 Bot 未启用但项目启用）', () => {
    expect(effectivePluginIds(profile(['x']), []).has('x')).toBe(true);
    expect(effectivePluginIds(profile(undefined), ['y'])).toEqual(new Set(['y']));
    expect(effectivePluginIds(profile([]), ['y'])).toEqual(new Set(['y']));
  });

  it('返回可变 Set 的独立副本：改动入参不影响已得的集', () => {
    const overlay = ['p'];
    const set = effectivePluginIds(profile(['b']), overlay);
    overlay.push('late');
    expect(set).toEqual(new Set(['b', 'p']));
  });
});
