import { describe, expect, it } from 'vitest';
// 相对导入：desktop 测试项目没有 $lib 别名（只有 desktop-svelte 有）。
import { enUS } from '../../i18n/locales/en-US';
import { zhCN } from '../../i18n/locales/zh-CN';
import {
  BOT_CONFIG_ANCHOR_SECTIONS,
  BOT_CONFIG_SECTION_LABEL_KEYS,
  type BotConfigSection,
} from './bot-config-sections';

/**
 * P2 注入模型：apps / mcp / mail 三区块收编为「插件」后，旧深链锚点保留为别名
 * （shared settings-catalog 的 bot.apps / bot.mcp-servers 条目仍指向它们）。
 */

describe('bot-config-sections', () => {
  it('区块枚举不再含 apps / mcp / mail，含 plugins', () => {
    const sections = Object.keys(BOT_CONFIG_SECTION_LABEL_KEYS) as BotConfigSection[];
    expect(sections).toContain('plugins');
    expect(sections).not.toContain('apps');
    expect(sections).not.toContain('mcp');
    expect(sections).not.toContain('mail');
  });

  it('旧锚点 bot-apps / bot-mcp 是 bot-plugins 的别名（设置卡深链不断）', () => {
    expect(BOT_CONFIG_ANCHOR_SECTIONS['bot-apps']).toBe('plugins');
    expect(BOT_CONFIG_ANCHOR_SECTIONS['bot-mcp']).toBe('plugins');
    expect(BOT_CONFIG_ANCHOR_SECTIONS['bot-plugins']).toBe('plugins');
    // 未受影响的锚点维持原映射。
    expect(BOT_CONFIG_ANCHOR_SECTIONS['bot-agent']).toBe('model');
    expect(BOT_CONFIG_ANCHOR_SECTIONS['bot-inkcop-agents']).toBe('inkcop');
  });

  it('每个区块的文案键在两份词典里都有（缺 key 的分区会渲染出键名）', () => {
    for (const key of Object.values(BOT_CONFIG_SECTION_LABEL_KEYS)) {
      expect(zhCN[key as keyof typeof zhCN], key).toBeTruthy();
      expect(enUS[key as keyof typeof enUS], key).toBeTruthy();
    }
  });
});
