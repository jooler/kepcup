import { describe, expect, it } from 'vitest';

import {
  BOT_KIND_MAX_CHARS,
  BOT_KIND_PRESETS,
  botKindLabel,
  botKindSchema,
  isBotKindPresetId,
  normalizeBotKind,
  parseBotKind,
} from '../../src/domain/bot-kind.js';

/**
 * bot.kind（0059）的纯函数：写入前的归一、读侧的宽容解析、展示名。
 * 消费者（core 的 rowToBot、save_profile 工具、<identity> 注入）都走这三者，
 * 所以规则只在这里定义一次。
 */

describe('normalizeBotKind', () => {
  it('内置 id 大小写不敏感，自定义分类保留原文', () => {
    expect(normalizeBotKind(' Coding ')).toBe('coding');
    expect(normalizeBotKind('前端开发')).toBe('前端开发');
  });

  it('模型直接回内置标签时归一成稳定 id（中英标签都认）', () => {
    for (const preset of BOT_KIND_PRESETS) {
      expect(normalizeBotKind(preset.label)).toBe(preset.id);
      expect(normalizeBotKind(preset.labelEn.toUpperCase())).toBe(preset.id);
    }
  });

  it('去掉控制字符与尖括号（分类会进系统提示词），并合并空白', () => {
    expect(normalizeBotKind('  法\u0000务\u001b  ')).toBe('法 务');
    expect(normalizeBotKind('<b>运营</b>')).toBe('b运营/b');
    expect(normalizeBotKind('数据\n分析')).toBe('数据 分析');
  });
});

describe('parseBotKind', () => {
  it('读侧接受 null / undefined / 非法值，统一返回 null', () => {
    expect(parseBotKind(null)).toBeNull();
    expect(parseBotKind(undefined)).toBeNull();
    expect(parseBotKind('   ')).toBeNull();
    expect(parseBotKind('x'.repeat(BOT_KIND_MAX_CHARS + 1))).toBeNull();
  });

  it('合法值归一后返回（与写侧落库的值一致）', () => {
    expect(parseBotKind('Coding')).toBe('coding');
    expect(parseBotKind('法务')).toBe('法务');
    expect(botKindSchema.safeParse(parseBotKind(' 写作与文档 ')).success).toBe(true);
  });
});

describe('isBotKindPresetId / botKindLabel', () => {
  it('内置 id 只认清单里的稳定值', () => {
    expect(isBotKindPresetId('coding')).toBe(true);
    expect(isBotKindPresetId('Coding')).toBe(false);
    expect(isBotKindPresetId('法务')).toBe(false);
  });

  it('内置分类按语言给标签，自定义分类原样返回', () => {
    expect(botKindLabel('coding')).toBe('编程与开发');
    expect(botKindLabel('coding', 'en-US')).toBe('Programming & development');
    expect(botKindLabel('法务')).toBe('法务');
    expect(botKindLabel('法务', 'en-US')).toBe('法务');
  });
});
