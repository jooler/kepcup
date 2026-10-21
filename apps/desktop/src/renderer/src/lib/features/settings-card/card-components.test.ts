import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CARD_KEYS,
  cardComponentProblems,
  getSettingItem,
  SETTING_ITEMS,
  type AgentView,
  type SettingItem,
} from '@kepcup/shared';
import {
  cardEmbeddable,
  embeddedAgentId,
  SETTING_CARD_COMPONENTS,
  type EmbedContext,
} from './card-components';
import { SETTING_CARD_CONTRIBUTIONS } from './cards/index.js';

/**
 * §4.3 测试二（组件部分）：每个 `card !== null` 的目录条目在渲染层映射里都有组件；
 * 映射登记的组件确实被 SettingCardEmbed 引入并按键分发。
 */

const embedSource = readFileSync(new URL('./SettingCardEmbed.svelte', import.meta.url), 'utf8');

function item(id: string): SettingItem {
  const found = getSettingItem(id);
  if (found === null) throw new Error(`missing catalog item ${id}`);
  return found;
}

const context = (patch: Partial<EmbedContext> = {}): EmbedContext => ({
  botId: 'bot_a',
  conversationId: 'conv_group',
  workdirId: 'proj_1',
  prefill: null,
  agent: (id) => (id === 'codex' ? ({ id: 'codex' } as AgentView) : null),
  defaultAgentId: null,
  ...patch,
});

describe('CardKey → 组件映射', () => {
  it('贡献表覆盖全部卡片键，无重复；派生映射与 CARD_KEYS 一致', () => {
    const keys = SETTING_CARD_CONTRIBUTIONS.map((card) => card.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...CARD_KEYS].sort());
    expect(cardComponentProblems(Object.keys(SETTING_CARD_COMPONENTS))).toEqual([]);
    expect(Object.keys(SETTING_CARD_COMPONENTS).sort()).toEqual([...CARD_KEYS].sort());
  });

  it('每个有卡片键的条目在贡献表里有登记', () => {
    const registered = new Map(SETTING_CARD_CONTRIBUTIONS.map((card) => [card.key, card]));
    for (const entry of SETTING_ITEMS) {
      if (entry.card === null) continue;
      const contribution = registered.get(entry.card);
      expect(contribution, entry.id).toBeDefined();
    }
  });

  it('SettingCardEmbed 引入了每个登记的组件，并为每个键写了分支', () => {
    for (const [key, component] of Object.entries(SETTING_CARD_COMPONENTS)) {
      expect(embedSource).toMatch(new RegExp(`import ${component} from `));
      expect(embedSource).toMatch(new RegExp(`<${component}\\b`));
      expect(embedSource).toContain(`item.card === '${key}'`);
    }
  });

  it('每个有卡片键的条目在完整上下文里都能内嵌（或明确需要预填）', () => {
    for (const entry of SETTING_ITEMS) {
      if (entry.card === null) continue;
      const full = context({
        prefill: { app: 'notion', agent: 'codex' },
      });
      expect(cardEmbeddable(entry, full), entry.id).toBe(true);
    }
  });
});

describe('cardEmbeddable（缺上下文时退回跳转卡）', () => {
  it('无卡片键不能嵌', () => {
    expect(cardEmbeddable(item('profile.user-facts'), context())).toBe(false);
    expect(cardEmbeddable(item('general.theme'), context())).toBe(true);
  });

  it('项目组卡要有项目组会话，工作目录卡要有工作目录', () => {
    expect(cardEmbeddable(item('project.title'), context({ conversationId: null }))).toBe(false);
    expect(cardEmbeddable(item('project.members'), context())).toBe(true);
    expect(cardEmbeddable(item('workdir.ports'), context({ workdirId: null }))).toBe(false);
    expect(cardEmbeddable(item('workdir.protect-rules'), context())).toBe(true);
  });

  it('bot 范围卡要有作用 Bot', () => {
    expect(cardEmbeddable(item('bot.model'), context())).toBe(true);
    expect(cardEmbeddable(item('bot.model'), context({ botId: null }))).toBe(false);
    expect(cardEmbeddable(item('mail.account'), context({ botId: null }))).toBe(false);
  });

  it('逐工具策略和 MCP 启停不靠预填也能嵌（user-only 会清空预填，定位在 before）', () => {
    expect(cardEmbeddable(item('connections.tool-policy'), context())).toBe(true);
    expect(cardEmbeddable(item('mcp.servers'), context())).toBe(true);
  });

  it('新建共享浏览器资料不靠作用对象也能嵌', () => {
    expect(cardEmbeddable(item('browser.shared-profiles'), context())).toBe(true);
    expect(cardEmbeddable(item('browser.shared-profiles'), context({ botId: null }))).toBe(true);
  });

  it('工具链、沙箱和命令白名单不靠预填也能嵌', () => {
    expect(cardEmbeddable(item('environment.toolchains'), context())).toBe(true);
    expect(
      cardEmbeddable(item('environment.toolchains'), context({ prefill: null, botId: null })),
    ).toBe(true);
    expect(cardEmbeddable(item('environment.sandbox'), context())).toBe(true);
    expect(
      cardEmbeddable(item('environment.sandbox'), context({ prefill: null, botId: null })),
    ).toBe(true);
    expect(cardEmbeddable(item('environment.allowlist'), context())).toBe(true);
    expect(
      cardEmbeddable(
        item('environment.allowlist'),
        context({ prefill: { pattern: 'npm test' }, botId: null }),
      ),
    ).toBe(true);
  });

  it('连接应用要知道连哪个（预填 app）', () => {
    expect(cardEmbeddable(item('connections.connect'), context())).toBe(false);
    expect(
      cardEmbeddable(item('connections.connect'), context({ prefill: { app: 'notion' } })),
    ).toBe(true);
  });

  it('外部智能体：预填优先，其次默认智能体；目录里没有就不能嵌', () => {
    expect(embeddedAgentId(context({ prefill: { agent: 'codex' } }))).toBe('codex');
    expect(embeddedAgentId(context({ defaultAgentId: 'codex' }))).toBe('codex');
    expect(embeddedAgentId(context({ prefill: { agent: 'nope' } }))).toBeNull();
    expect(cardEmbeddable(item('agents.external'), context())).toBe(false);
  });

  it('默认模型 / 厂商 / 联网 / 能力 / 硬件直接可嵌', () => {
    for (const id of [
      'models.default-main',
      'models.provider',
      'search.provider',
      'capability.image',
      'hardware.camera',
    ]) {
      expect(cardEmbeddable(item(id), context({ botId: null })), id).toBe(true);
    }
  });
});
