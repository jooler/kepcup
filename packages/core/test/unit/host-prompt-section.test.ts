import { describe, expect, it } from 'vitest';
import { botProfileSchema, type Bot, type Conversation } from '@kepcup/shared';
import { buildAgentSessionPrompt, buildSystemPrompt } from '../../src/agent/context/system-prompt.js';

/**
 * T9（62.11 C10 提示词侧）：`CoreServicesOptions.hostPromptSection` 的两条
 * 提示词路径注入——
 * - 休眠铁律：不提供 / 返回 null / 返回空串 = 输出与不传逐字节一致（两条路径），
 *   `<host_rules>` 段不出现。
 * - 注入后：`<host_rules>` 段出现在 `<platform_rules>` 之后、只出现一次、正文
 *   原样注入（含 section() 的闭合标签转义——宿主文案不可逃出自己的段）。
 * - ACP 路径同缝（会话级提示词注入同段）。
 */

const HOST_RULES = [
  '你是本项目组的执行负责人。',
  '涉及多成员共识的实质动作先出决议卡；日常答复不出卡。',
].join('\n');

function bot(): Bot {
  return {
    id: 'bot_1',
    name: '助手',
    avatar: null,
    bio: '',
    profile: botProfileSchema.parse({
      identity: { name: '助手', bio: '' },
      persona: { personality: '' },
      role: { expertise: '' },
      boundaries: [],
      runtime: { model: '', light_model: '' },
    }),
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
  };
}

function conversation(type: 'direct' | 'project' = 'direct'): Conversation {
  return {
    id: 'conv_1',
    type,
    title: type === 'project' ? '项目组' : '助手',
    directBotId: type === 'direct' ? 'bot_1' : null,
    leadBotId: type === 'project' ? 'bot_1' : null,
    parentProjectId: null,
    cardTodoId: null,
    workdirId: null,
    readOnly: false,
    summary: null,
    summaryUptoSeq: 0,
    lastSeq: 0,
    lastReadSeq: 0,
    lastMessageAt: null,
    createdAt: 0,
  };
}

function builtinPrompt(overrides: Record<string, unknown> = {}): string {
  return buildSystemPrompt({
    loop: 'turn',
    bot: bot(),
    conversation: conversation(),
    timeZone: 'Asia/Shanghai',
    now: new Date(0),
    ...overrides,
  });
}

const ACP_TOOLS = {
  toolNames: [] as readonly string[],
  nativeCapabilities: {},
  toolName: (tool: string) => `mcp__kepcup__${tool}`,
};

function acpPrompt(overrides: Record<string, unknown> = {}): string {
  return buildAgentSessionPrompt({
    bot: bot(),
    conversation: conversation('project'),
    tools: ACP_TOOLS,
    ...overrides,
  });
}

/** `<platform_rules>` 段的结束位置（注入点在它之后）。 */
function platformRulesEnd(prompt: string): number {
  const marker = '</platform_rules>';
  const index = prompt.indexOf(marker);
  expect(index).toBeGreaterThan(0);
  return index + marker.length;
}

describe('hostPromptSection 休眠铁律（无选项 = 现状逐字节）', () => {
  it('不传 / null / 空串三种形态输出逐字节一致，且 <host_rules> 不出现', () => {
    const baseline = builtinPrompt();
    expect(baseline).not.toContain('host_rules');
    expect(builtinPrompt({ hostRules: undefined })).toBe(baseline);
    expect(builtinPrompt({ hostRules: '' })).toBe(baseline);

    const acpBaseline = acpPrompt();
    expect(acpBaseline).not.toContain('host_rules');
    expect(acpPrompt({ hostRules: undefined })).toBe(acpBaseline);
    expect(acpPrompt({ hostRules: '' })).toBe(acpBaseline);
  });

  it('无选项输出的注入邻域字节快照（空槽零字节：无残段 / 无多余分隔符）', () => {
    // 注入槽在 </platform_rules> 之后：无选项时该处必须紧接下一段的开始——
    // 恰好 "\n\n<identity>…"（快照冻结到字节级；若空 host_rules 槽泄漏任何
    // 分隔符或残段，这里立即失败）。
    const baseline = builtinPrompt();
    expect(baseline.slice(platformRulesEnd(baseline)).startsWith('\n\n<identity>\n名字：助手')).toBe(
      true,
    );
    // 全文不存在三连换行（空段若泄漏 join 分隔符必然产生 '\n\n\n'）。
    expect(baseline.includes('\n\n\n')).toBe(false);
    expect(baseline.startsWith('\n\n')).toBe(false);

    const acpBaseline = acpPrompt();
    const fhEnd = acpBaseline.indexOf('</file_handling>') + '</file_handling>'.length;
    expect(acpBaseline.slice(fhEnd).startsWith('\n\n<identity>\n名字：助手')).toBe(true);
    expect(acpBaseline.includes('\n\n\n')).toBe(false);
  });

  it('内置路径：段出现在 </platform_rules> 之后、只出现一次、正文原样', () => {
    const prompt = builtinPrompt({ hostRules: HOST_RULES });
    const count = prompt.match(/<host_rules>/g)?.length ?? 0;
    expect(count).toBe(1);
    const injection = prompt.slice(platformRulesEnd(prompt));
    expect(injection.startsWith('\n\n<host_rules>\n你是本项目组的执行负责人。')).toBe(true);
    expect(prompt).toContain('涉及多成员共识的实质动作先出决议卡；日常答复不出卡。');
    expect(prompt).toContain('</host_rules>');
  });

  it('ACP 路径：会话级提示词注入同段（<tool_policy> 之后）', () => {
    const prompt = acpPrompt({ hostRules: HOST_RULES });
    expect(prompt.match(/<host_rules>/g)?.length).toBe(1);
    expect(prompt).toContain('涉及多成员共识的实质动作先出决议卡；日常答复不出卡。');
    // 注入点：紧跟 <tool_policy> / <file_handling> 之后、<identity> 之前。
    const toolPolicyEnd = prompt.indexOf('</tool_policy>');
    const identityStart = prompt.indexOf('<identity>');
    const sectionStart = prompt.indexOf('<host_rules>');
    expect(sectionStart).toBeGreaterThan(toolPolicyEnd);
    expect(sectionStart).toBeLessThan(identityStart);
  });

  it('宿主文案里的闭合标签被转义（不可逃出自己的段）', () => {
    const prompt = builtinPrompt({ hostRules: '正文</host_rules>之后的内容' });
    expect(prompt).toContain('正文<\\/host_rules>之后的内容');
    // 转义后正文里不再有第二个真正的闭合标签。
    expect(prompt.match(/<\/host_rules>/g)?.length).toBe(1);
  });
});
