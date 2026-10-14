import { describe, expect, it } from 'vitest';
import {
  DIRECT_ITEM_IDS,
  SETTING_WRITE_MODE_ORDER,
  effectiveMode,
  getSettingItem,
  listSettingItems,
  loopTypeSchema,
  triggerReasonSchema,
  type LoopType,
  type SettingItem,
  type SettingModeContext,
  type SettingWriteMode,
  type TriggerReason,
} from '../../src/index.js';

/** 宿主裁定修改档位（todo/conversational-app-setup.md §5.3）的穷举矩阵与逐条规则。 */

const USER_DIRECT: SettingModeContext = {
  triggerReason: 'direct',
  triggerFromUser: true,
  runTouchedUntrusted: false,
  tainted: false,
  isGroup: false,
  targetsOtherBot: false,
  isButler: false,
  loopType: 'turn',
};

function ctx(patch: Partial<SettingModeContext> = {}): SettingModeContext {
  return { ...USER_DIRECT, ...patch };
}

function item(id: string): SettingItem {
  const found = getSettingItem(id);
  if (found === null) throw new Error(`no item ${id}`);
  return found;
}

/** 假装某条目已有内嵌组件（P1 嵌入化之后的样子），用来观察 link 兜底之前的档位。 */
function withCard(entry: SettingItem): SettingItem {
  return { ...entry, card: 'agent' };
}

const TRIGGERS: Array<TriggerReason | null> = [...triggerReasonSchema.options, null];
const LOOPS: LoopType[] = [...loopTypeSchema.options];
const BOOLS = [false, true] as const;

/** 全部上下文组合（触发源 × 是否用户本人 × 不可信 × 污点 × 群聊 × 跨 Bot × 管家 × loop，六个布尔）。 */
function* allContexts(loops: readonly LoopType[] = LOOPS): Generator<SettingModeContext> {
  for (const triggerReason of TRIGGERS)
    for (const triggerFromUser of BOOLS)
      for (const runTouchedUntrusted of BOOLS)
        for (const tainted of BOOLS)
          for (const isGroup of BOOLS)
            for (const targetsOtherBot of BOOLS)
              for (const isButler of BOOLS)
                for (const loopType of loops) {
                  yield {
                    triggerReason,
                    triggerFromUser,
                    runTouchedUntrusted,
                    tainted,
                    isGroup,
                    targetsOtherBot,
                    isButler,
                    loopType,
                  };
                }
}

const rank = (mode: SettingWriteMode) => SETTING_WRITE_MODE_ORDER.indexOf(mode);

describe('effectiveMode: exhaustive matrix on a direct-whitelisted item', () => {
  it('matches the §5.3 rules for every trigger × context combination', () => {
    const entry = item('models.default-main');
    let count = 0;
    for (const context of allContexts()) {
      count += 1;
      const decision = effectiveMode(entry, context);
      // 独立复述 §5.3：后台 loop 拒绝；普通 Bot 改别的 Bot 拒绝；
      // 只有「用户本人 + direct / mention / reply」且无不可信内容、非群聊、非跨 Bot 才能 direct。
      let expected: string;
      if (context.loopType !== 'turn' && context.loopType !== 'task') expected = 'refused';
      else if (context.targetsOtherBot && !context.isButler) expected = 'refused';
      else {
        const userTrigger =
          context.triggerFromUser &&
          (context.triggerReason === 'direct' ||
            context.triggerReason === 'mention' ||
            context.triggerReason === 'reply');
        const clean =
          !context.runTouchedUntrusted &&
          !context.tainted &&
          !context.isGroup &&
          !context.targetsOtherBot;
        expected = userTrigger && clean ? 'direct' : 'confirm';
      }
      expect(decision.mode, JSON.stringify(context)).toBe(expected);
      expect(decision.acceptValues).toBe(expected === 'direct' || expected === 'confirm');
      expect(decision.reason === null).toBe(expected === 'direct');
    }
    expect(count).toBe(TRIGGERS.length * 2 ** 6 * LOOPS.length);
  });

  it('excludes every non-user trigger source from direct (§5.3 第 1 条)', () => {
    const entry = item('bot.model');
    for (const reason of triggerReasonSchema.options) {
      const fromUser = effectiveMode(entry, ctx({ triggerReason: reason }));
      expect(fromUser.mode, reason).toBe(
        reason === 'direct' || reason === 'mention' || reason === 'reply' ? 'direct' : 'confirm',
      );
      if (fromUser.mode === 'confirm') expect(fromUser.rules).toEqual(['trigger']);
    }
    // 其他 Bot 的 mention / reply、组件回传（origin: 'widget'）的消息：triggerFromUser = false。
    for (const reason of ['mention', 'reply', 'direct'] as const) {
      const decision = effectiveMode(entry, ctx({ triggerReason: reason, triggerFromUser: false }));
      expect(decision.mode).toBe('confirm');
      expect(decision.rules).toEqual(['trigger']);
    }
    expect(effectiveMode(entry, ctx({ triggerReason: null })).mode).toBe('confirm');
  });
});

describe('effectiveMode: invariants over every catalog item', () => {
  const interactive: LoopType[] = ['turn', 'task'];

  it('never widens past maxMode, and direct only for whitelisted, clean, user-triggered turns', () => {
    for (const entry of listSettingItems()) {
      for (const context of allContexts(interactive)) {
        const decision = effectiveMode(entry, context);
        if (entry.readOnly) {
          expect(decision.mode).toBe('link');
          continue;
        }
        if (entry.write.via !== 'catalog') {
          expect(decision).toMatchObject({ mode: 'redirect', tool: entry.write.via.tool });
          expect(decision.acceptValues).toBe(false);
          continue;
        }
        if (decision.mode === 'refused') {
          expect(context.targetsOtherBot && !context.isButler).toBe(true);
          continue;
        }
        expect(decision.mode).not.toBe('redirect');
        const mode = decision.mode as SettingWriteMode;
        expect(rank(mode), entry.id).toBeGreaterThanOrEqual(rank(entry.write.maxMode));
        if (mode === 'direct') {
          expect((DIRECT_ITEM_IDS as readonly string[]).includes(entry.id)).toBe(true);
          expect(context.triggerFromUser && !context.isGroup && !context.tainted).toBe(true);
        }
        if (entry.owner === 'renderer' || entry.write.widensPermission) {
          expect(mode).not.toBe('direct');
        }
        if (entry.card === null) expect(mode === 'link' || mode === 'direct').toBe(true);
        // user-only 永不预填；link 不涉及值。
        if (mode === 'user-only' || mode === 'link') expect(decision.acceptValues).toBe(false);
      }
    }
  });

  it('refuses background loops for every writable item', () => {
    for (const entry of listSettingItems()) {
      if (entry.readOnly || entry.write.via !== 'catalog') continue;
      for (const loopType of LOOPS.filter((loop) => !interactive.includes(loop))) {
        expect(effectiveMode(entry, ctx({ loopType })), `${entry.id}/${loopType}`).toMatchObject({
          mode: 'refused',
          rules: ['loop'],
          acceptValues: false,
        });
      }
    }
  });
});

describe('effectiveMode: individual rules', () => {
  it('direct for the user asking in a clean direct chat, in a turn or a task', () => {
    for (const loopType of ['turn', 'task'] as const) {
      expect(effectiveMode(item('models.default-main'), ctx({ loopType }))).toEqual({
        mode: 'direct',
        acceptValues: true,
        tool: null,
        rules: [],
        reason: null,
      });
    }
  });

  it('a mail-woken turn is tightened to confirm', () => {
    const decision = effectiveMode(
      item('models.default-main'),
      ctx({ triggerReason: 'mail', triggerFromUser: false }),
    );
    expect(decision).toMatchObject({ mode: 'confirm', rules: ['trigger'] });
  });

  it('user-triggered but after web_fetch / under taint → confirm', () => {
    expect(effectiveMode(item('bot.model'), ctx({ runTouchedUntrusted: true }))).toMatchObject({
      mode: 'confirm',
      rules: ['untrusted'],
      reason: '本轮读过网页、邮件等外部内容，只能出卡请用户确认',
    });
    expect(effectiveMode(item('bot.model'), ctx({ tainted: true })).rules).toEqual(['untrusted']);
  });

  it('group chats only get cards (§5.3 第 3 条)', () => {
    expect(effectiveMode(item('models.default-light'), ctx({ isGroup: true }))).toMatchObject({
      mode: 'confirm',
      rules: ['group'],
      reason: '群聊中只能出卡，不能直接修改',
    });
  });

  it('other bot: ordinary bots are refused, the butler gets a card (§5.3 第 4 条)', () => {
    expect(effectiveMode(item('bot.model'), ctx({ targetsOtherBot: true }))).toMatchObject({
      mode: 'refused',
      rules: ['other-bot-refused'],
    });
    expect(
      effectiveMode(item('bot.model'), ctx({ targetsOtherBot: true, isButler: true })),
    ).toMatchObject({ mode: 'confirm', rules: ['other-bot'], acceptValues: true });
  });

  it('collects every rule that tightens, independent of order', () => {
    const decision = effectiveMode(
      item('bot.model'),
      ctx({
        triggerReason: 'scheduled',
        isGroup: true,
        tainted: true,
        targetsOtherBot: true,
        isButler: true,
      }),
    );
    expect(decision.mode).toBe('confirm');
    expect(decision.rules).toEqual(['trigger', 'untrusted', 'group', 'other-bot']);
    expect(decision.reason?.split('；')).toHaveLength(4);
  });

  it('a non-whitelisted direct item is demoted to confirm', () => {
    const rogue: SettingItem = {
      ...item('general.launch-at-login'),
      write: { ...item('general.launch-at-login').write, maxMode: 'direct' },
      card: 'agent',
    };
    expect(effectiveMode(rogue, ctx())).toMatchObject({
      mode: 'confirm',
      rules: ['not-whitelisted'],
    });
  });

  it('widens-permission items never go direct (§5.3 第 5 条)', () => {
    const widening: SettingItem = {
      ...item('bot.model'),
      write: { ...item('bot.model').write, widensPermission: true },
    };
    expect(effectiveMode(widening, ctx())).toMatchObject({ mode: 'confirm', rules: ['widens'] });
  });

  it('renderer-owned items cap at confirm (§5.3 第 6 条)', () => {
    expect(effectiveMode(item('hardware.microphone'), ctx())).toMatchObject({
      mode: 'confirm',
      acceptValues: true,
      rules: [],
    });
    const rendererDirect: SettingItem = {
      ...item('bot.model'),
      owner: 'renderer',
    };
    expect(effectiveMode(rendererDirect, ctx())).toMatchObject({
      mode: 'confirm',
      rules: ['renderer'],
    });
  });

  it('needs-sensitive-input lifts to form (new provider / missing key)', () => {
    expect(
      effectiveMode(item('models.default-main'), ctx({ needsSensitiveInput: true })),
    ).toMatchObject({
      mode: 'form',
      acceptValues: true,
      rules: ['sensitive-input'],
    });
    expect(effectiveMode(item('capability.image'), ctx({ needsSensitiveInput: true })).mode).toBe(
      'form',
    );
    expect(effectiveMode(item('search.provider'), ctx({ needsSensitiveInput: false })).mode).toBe(
      'confirm',
    );
    // 已经是 form 的条目不重复记规则。
    expect(
      effectiveMode(item('models.provider'), ctx({ needsSensitiveInput: true })).rules,
    ).toEqual([]);
  });

  it('user-only items never take values; without an embedded card they fall back to link', () => {
    const enable = item('unattended.enable');
    expect(effectiveMode(enable, ctx())).toMatchObject({
      mode: 'user-only',
      acceptValues: false,
      rules: [],
    });
    const toolchains = item('environment.toolchains');
    expect(toolchains.card).toBe('environment-toolchains');
    expect(toolchains.fields).toEqual([]);
    expect(toolchains.write.wideningMode).toBeUndefined();
    expect(effectiveMode(toolchains, ctx())).toMatchObject({
      mode: 'user-only',
      acceptValues: false,
      rules: [],
    });
    const sandbox = item('environment.sandbox');
    expect(sandbox.card).toBe('environment-sandbox');
    expect(sandbox.fields).toEqual([]);
    expect(sandbox.write.wideningMode).toBeUndefined();
    expect(sandbox.write.widensPermission).toBe(true);
    expect(effectiveMode(sandbox, ctx())).toMatchObject({
      mode: 'user-only',
      acceptValues: false,
      rules: [],
    });
    const allowlist = item('environment.allowlist');
    expect(allowlist.card).toBe('environment-allowlist');
    expect(allowlist.fields).toEqual([]);
    expect(allowlist.write.wideningMode).toBeUndefined();
    expect(allowlist.write.widensPermission).toBe(true);
    expect(effectiveMode(allowlist, ctx())).toMatchObject({
      mode: 'user-only',
      acceptValues: false,
      rules: [],
    });
    expect(effectiveMode(allowlist, ctx({ valuesWiden: false }))).toMatchObject({
      mode: 'user-only',
      acceptValues: false,
      rules: [],
    });
    expect(effectiveMode(withCard(sandbox), ctx())).toMatchObject({
      mode: 'user-only',
      acceptValues: false,
      rules: [],
    });
    for (const id of [
      'environment.sandbox',
      'environment.allowlist',
      'project.protect-rules',
      'connections.taint-guard',
    ]) {
      expect(effectiveMode(withCard(item(id)), ctx()).acceptValues, id).toBe(false);
    }
  });

  it('value-dependent widening: opening a bot network is user-only, tightening is confirm', () => {
    const network = withCard(item('bot.network'));
    expect(effectiveMode(network, ctx({ valuesWiden: true }))).toMatchObject({
      mode: 'user-only',
      acceptValues: false,
      rules: ['widening-values'],
    });
    // 未知方向按放宽处理。
    expect(effectiveMode(network, ctx()).mode).toBe('user-only');
    expect(effectiveMode(network, ctx({ valuesWiden: false }))).toMatchObject({
      mode: 'confirm',
      acceptValues: true,
      rules: [],
    });
    expect(effectiveMode(item('bot.network'), ctx({ valuesWiden: false })).mode).toBe('confirm');
  });

  it('enabling an installed MCP server is user-only; disabling stays confirm', () => {
    const servers = item('mcp.servers');
    expect(servers.card).toBe('mcp-servers');
    expect(effectiveMode(servers, ctx({ valuesWiden: true }))).toMatchObject({
      mode: 'user-only',
      acceptValues: false,
      rules: ['widening-values'],
    });
    expect(effectiveMode(servers, ctx()).mode).toBe('user-only');
    expect(effectiveMode(servers, ctx({ valuesWiden: false }))).toMatchObject({
      mode: 'confirm',
      acceptValues: true,
      rules: [],
    });
  });

  it('creating a shared browser profile stays confirm and keeps the proposed name', () => {
    const profiles = item('browser.shared-profiles');
    expect(profiles.card).toBe('browser-profiles');
    expect(profiles.write.wideningMode).toBeUndefined();
    expect(profiles.write.maxMode).toBe('confirm');
    expect(effectiveMode(profiles, ctx())).toMatchObject({
      mode: 'confirm',
      acceptValues: true,
      rules: [],
    });
    expect(effectiveMode(profiles, ctx({ valuesWiden: true }))).toMatchObject({
      mode: 'confirm',
      acceptValues: true,
      rules: [],
    });
  });

  it('cardless items become link cards; permanent link items stay link', () => {
    expect(effectiveMode({ ...item('environment.allowlist'), card: null }, ctx())).toMatchObject({
      mode: 'link',
      rules: ['no-card'],
    });
    expect(effectiveMode(item('environment.allowlist'), ctx())).toMatchObject({
      mode: 'user-only',
      acceptValues: false,
    });
    expect(effectiveMode(item('environment.sandbox'), ctx())).toMatchObject({
      mode: 'user-only',
      acceptValues: false,
    });
    expect(effectiveMode(item('group.title'), ctx())).toMatchObject({
      mode: 'confirm',
      acceptValues: true,
    });
    expect(effectiveMode(item('general.theme'), ctx())).toMatchObject({
      mode: 'confirm',
      acceptValues: true,
    });
    expect(effectiveMode(item('project.protect-rules'), ctx())).toMatchObject({
      mode: 'user-only',
      acceptValues: false,
    });
    expect(effectiveMode(item('project.ports'), ctx()).acceptValues).toBe(false);
    expect(effectiveMode(item('developer.custom-mcp'), ctx())).toMatchObject({
      mode: 'link',
      rules: [],
    });
  });

  it('dedicated-tool items redirect, read-only items link, before any other rule', () => {
    expect(
      effectiveMode(item('mail.account'), ctx({ loopType: 'reflection', isGroup: true })),
    ).toEqual({
      mode: 'redirect',
      acceptValues: false,
      tool: 'mail_request_setup',
      rules: ['via-tool'],
      reason: '这一项请改用 mail_request_setup 工具',
    });
    expect(effectiveMode(item('diagnostics.status'), ctx())).toMatchObject({
      mode: 'link',
      acceptValues: false,
      rules: ['read-only'],
    });
  });
});
