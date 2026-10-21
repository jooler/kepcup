import { afterEach, describe, expect, it } from 'vitest';
import {
  agentText,
  connectorDescription,
  connectorUnavailableText,
  i18n,
  presetSkillText,
  vendorName,
} from './index';

afterEach(() => i18n.setLocale('zh-CN'));

describe('目录数据的界面文案', () => {
  it('连接应用描述按 slug 翻译，未知 slug 回退目录数据', () => {
    i18n.setLocale('en-US');
    expect(connectorDescription('notion', '中文描述')).toBe(
      'Search, read, and edit Notion pages and databases',
    );
    expect(connectorDescription('unknown-app', 'original')).toBe('original');
  });

  it('不可连接原因从 core 的中文原因映射到当前语言', () => {
    i18n.setLocale('en-US');
    expect(connectorUnavailableText('该应用没有可用的远程端点')).toBe(
      'This app has no available remote endpoint',
    );
    expect(connectorUnavailableText('暂不支持 api-key 认证方式')).toBe(
      'api-key authentication is not supported yet',
    );
    expect(
      connectorUnavailableText('该应用需要 KepCup 预注册的客户端（foo），当前版本未包含'),
    ).toBe(
      'This app requires a client preregistered by KepCup (foo), which this version does not include',
    );
    expect(connectorUnavailableText('自定义原因')).toBe('自定义原因');
  });

  it('预置技能、厂商与智能体目录文案按 id 翻译', () => {
    i18n.setLocale('en-US');
    expect(presetSkillText('docx', 'name', 'Word 文档')).toBe('Word documents');
    expect(presetSkillText('docx', 'summary', '中文')).toContain('reports');
    expect(vendorName('volcengine', '火山方舟')).toBe('Volcengine Ark');
    expect(agentText('claude-acp', 'description', '中文')).toContain('ACP');
    expect(agentText('claude-acp', 'authNote', '中文')).toContain('Claude Pro');

    i18n.setLocale('zh-CN');
    expect(presetSkillText('docx', 'name', 'fallback')).toBe('Word 文档');
    expect(vendorName('dashscope', 'fallback')).toBe('阿里云百炼');
  });
});
