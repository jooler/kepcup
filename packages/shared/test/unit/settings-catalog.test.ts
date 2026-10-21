import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_SETTING_IDS,
  CARD_KEYS,
  DIRECT_ITEM_IDS,
  EXCLUDED_SETTING_LOCATIONS,
  PENDING_DESKTOP_ANCHORS,
  SENSITIVE_FIELD_TYPES,
  SETTINGS_SEARCH_MAX_RESULTS,
  SETTING_GROUP_TITLES,
  cardComponentProblems,
  checkProposedValues,
  closestSettingItemIds,
  getSettingItem,
  groupOverview,
  itemIdsForBotPaths,
  itemIdsForServiceMethod,
  itemIdsForSettingsPaths,
  listSettingItems,
  searchSettingItems,
  sensitiveFieldNames,
  settingItemSchema,
  settingsAdapterCoverageProblems,
  settingsCoverageProblems,
  settingsSchema,
  settingsUpdateInputSchema,
  type SettingItem,
  type SettingsUiScan,
} from '../../src/index.js';
import { scanSettingsUi } from './settings-ui-scan.js';

/** 设置目录（todo/conversational-app-setup.md §4）：条目完整性、白名单、敏感字段、覆盖率。 */

const items = listSettingItems();

describe('settings catalog integrity', () => {
  it('ships schema-valid items with unique ids', () => {
    for (const entry of items) {
      expect(settingItemSchema.safeParse(entry).success, entry.id).toBe(true);
    }
    const ids = items.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(getSettingItem(id)?.id).toBe(id);
    expect(getSettingItem('no.such-item')).toBeNull();
  });

  it('registers every row of the §4.2 table', () => {
    const ids = new Set(items.map((entry) => entry.id));
    for (const id of [
      'models.default-main',
      'models.default-light',
      'models.provider',
      ...Object.values(CAPABILITY_SETTING_IDS),
      'models.embedding-local',
      'search.provider',
      'connections.connect',
      'connections.tool-policy',
      'mail.account',
      'agents.external',
      'bot.model',
      'bot.light-model',
      'bot.browser-profile',
      'bot.network',
      'bot.mcp-servers',
      'bot.apps',
      'bot.skills',
      'bot.identity',
      'skills.install',
      'schedules.schedule',
      'schedules.watch',
      'profile.user-facts',
      'project.title',
      'project.goal',
      'project.members',
      'project.lead',
      'workdir.protect-rules',
      'workdir.ports',
      'hardware.microphone',
      'hardware.camera',
      'general.theme',
      'general.language',
      'general.launch-at-login',
      'general.task-loop',
      'background.tasks',
      'unattended.enable',
      'unattended.disable',
      'environment.toolchains',
      'environment.sandbox',
      'environment.allowlist',
      'developer.custom-mcp',
      'developer.oauth-clients',
      'developer.mcpb',
      'diagnostics.status',
      'diagnostics.usage',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
    // 七个能力模型条目与 settings.capabilityModels 的键一一对应。
    const capabilityKeys = Object.keys(settingsSchema.parse({}).capabilityModels).sort();
    expect(Object.keys(CAPABILITY_SETTING_IDS).sort()).toEqual(capabilityKeys);
  });

  it('points dedicated-tool items at the existing tools (§5.2)', () => {
    const via = Object.fromEntries(
      items.flatMap((entry) =>
        entry.write.via === 'catalog' ? [] : [[entry.id, entry.write.via.tool]],
      ),
    );
    expect(via).toEqual({
      'connections.connect': 'app_request_connection',
      'mail.account': 'mail_request_setup',
      'bot.identity': 'propose_profile_change',
      'bot.file-access': 'request_access',
      'skills.install': 'install_skill',
      'schedules.schedule': 'schedule',
      'schedules.watch': 'watch_create',
    });
  });

  it('pins the user-only safety switches (§5.3 第 5 条、决策 4)', () => {
    const userOnly = items
      .filter((entry) => entry.write.maxMode === 'user-only')
      .map((entry) => entry.id);
    expect(userOnly.sort()).toEqual(
      [
        'connections.taint-guard',
        'environment.allowlist',
        'environment.sandbox',
        'environment.toolchains',
        'workdir.ports',
        'workdir.protect-rules',
        'unattended.enable',
      ].sort(),
    );
    // 放开 Bot 网络 / 放宽工具策略 / 放宽智能体权限：值相关的 user-only。
    for (const id of ['bot.network', 'connections.tool-policy', 'mcp.servers', 'bot.agent']) {
      expect(getSettingItem(id)?.write.wideningMode, id).toBe('user-only');
    }
    for (const entry of items) {
      if (entry.write.maxMode === 'user-only' || entry.write.wideningMode !== undefined) {
        expect(entry.write.widensPermission, entry.id).toBe(true);
      }
    }
  });

  it('keeps renderer-owned items at confirm at most, with no core store', () => {
    const renderer = items.filter((entry) => entry.owner === 'renderer');
    expect(renderer.map((entry) => entry.id).sort()).toEqual(
      ['general.language', 'general.theme', 'hardware.camera', 'hardware.microphone'].sort(),
    );
    for (const entry of renderer) {
      expect(entry.write.maxMode).not.toBe('direct');
      expect(entry.store.kind).toBe('renderer');
    }
    for (const entry of items) {
      if (entry.store.kind === 'renderer') expect(entry.owner).toBe('renderer');
    }
  });

  it('marks read-only items as link-only and never writable', () => {
    for (const entry of items.filter((candidate) => candidate.readOnly)) {
      expect(entry.write.maxMode).toBe('link');
      expect(entry.card).toBeNull();
      expect(entry.store.kind).toBe('none');
    }
  });

  it('uses only registered card keys (CARD_KEYS = keys the items use)', () => {
    const used = new Set(items.flatMap((entry) => (entry.card === null ? [] : [entry.card])));
    expect([...used].sort()).toEqual([...CARD_KEYS].sort());
  });

  it('matches the store scope: bot items store on the bot, global items never do', () => {
    for (const entry of items) {
      if (entry.store.kind === 'bot') expect(entry.scope, entry.id).toBe('bot');
      if (entry.scope === 'project' || entry.scope === 'workdir') {
        expect(entry.store.kind, entry.id).toBe('service');
      }
    }
  });
});

describe('direct whitelist (§4.3 测试三)', () => {
  it('only DIRECT_ITEM_IDS carry maxMode direct', () => {
    const direct = items
      .filter((entry) => entry.write.maxMode === 'direct')
      .map((entry) => entry.id);
    expect(direct.sort()).toEqual([...DIRECT_ITEM_IDS].sort());
    expect([...DIRECT_ITEM_IDS].sort()).toEqual(
      ['bot.light-model', 'bot.model', 'models.default-light', 'models.default-main'].sort(),
    );
  });

  it('direct items are core-owned model pickers with an embedded card and nothing sensitive', () => {
    for (const id of DIRECT_ITEM_IDS) {
      const entry = getSettingItem(id)!;
      expect(entry.owner).toBe('core');
      expect(entry.card).not.toBeNull();
      expect(entry.write.via).toBe('catalog');
      expect(entry.write.widensPermission).toBe(false);
      expect(entry.write.wideningMode).toBeUndefined();
      expect(entry.fields.map((spec) => spec.type)).toEqual(['model']);
      expect(sensitiveFieldNames(entry)).toEqual([]);
    }
  });
});

describe('sensitive fields (§七)', () => {
  it('marks every secret / oauth / account field sensitive', () => {
    for (const entry of items) {
      for (const spec of entry.fields) {
        if (SENSITIVE_FIELD_TYPES.has(spec.type))
          expect(spec.sensitive, `${entry.id}.${spec.name}`).toBe(true);
      }
    }
  });

  it('never lets an item with sensitive fields be direct, and rejects them in values', () => {
    const withSecrets = items.filter((entry) => sensitiveFieldNames(entry).length > 0);
    expect(withSecrets.length).toBeGreaterThan(0);
    for (const entry of withSecrets) {
      expect(entry.write.maxMode, entry.id).not.toBe('direct');
      // confirm 档条目（如能力模型）也只能预填非敏感字段：values 带上敏感字段即拒绝。
      const values = Object.fromEntries(sensitiveFieldNames(entry).map((name) => [name, 'sk-x']));
      expect(checkProposedValues(entry, values).sensitive.sort()).toEqual(
        sensitiveFieldNames(entry).sort(),
      );
    }
  });

  it('flags unknown keys and passes clean values', () => {
    const image = getSettingItem('capability.image')!;
    expect(checkProposedValues(image, { provider: 'openai', model: 'openai/gpt-image-1' })).toEqual(
      {
        sensitive: [],
        unknown: [],
      },
    );
    expect(checkProposedValues(image, { apiKey: 'sk', bogus: 1 })).toEqual({
      sensitive: ['apiKey'],
      unknown: ['bogus'],
    });
  });
});

describe('catalog queries', () => {
  it('finds items by need, keyword and title, capped at 10', () => {
    expect(searchSettingItems('生成图片')[0]?.id).toBe('capability.image');
    expect(searchSettingItems('我想让你帮我生成图片')[0]?.id).toBe('capability.image');
    expect(searchSettingItems('读我的邮件')[0]?.id).toBe('mail.account');
    expect(searchSettingItems('Notion')[0]?.id).toBe('connections.connect');
    expect(searchSettingItems('换个默认模型').map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['models.default-main', 'models.default-light']),
    );
    expect(searchSettingItems('capability.video')[0]?.id).toBe('capability.video');
    expect(searchSettingItems('模型').length).toBeLessThanOrEqual(SETTINGS_SEARCH_MAX_RESULTS);
    expect(searchSettingItems('')).toEqual([]);
    expect(searchSettingItems('   ')).toEqual([]);
    expect(searchSettingItems('完全无关的词zzz')).toEqual([]);
  });

  it('suggests the closest ids for an unknown id', () => {
    expect(closestSettingItemIds('models.default-mian')).toContain('models.default-main');
    expect(closestSettingItemIds('capability.imag')).toContain('capability.image');
    expect(closestSettingItemIds('whatever').length).toBeLessThanOrEqual(3);
  });

  it('groups every item exactly once in the overview', () => {
    const overview = groupOverview();
    const flat = overview.flatMap((row) => row.itemIds);
    expect(flat.sort()).toEqual(items.map((entry) => entry.id).sort());
    for (const row of overview) {
      expect(row.title).toBe(SETTING_GROUP_TITLES[row.group]);
      expect(row.itemIds.length).toBeGreaterThan(0);
    }
  });

  it('maps settings / bot / service writes to item ids (settings.changed)', () => {
    expect(itemIdsForSettingsPaths(['capabilityModels']).sort()).toEqual(
      Object.values(CAPABILITY_SETTING_IDS).sort(),
    );
    expect(itemIdsForSettingsPaths(['capabilityModels.image'])).toEqual(['capability.image']);
    expect(itemIdsForSettingsPaths(['defaultMainModel', 'defaultLightModel'])).toEqual([
      'models.default-main',
      'models.default-light',
    ]);
    expect(itemIdsForSettingsPaths(['apps'])).toEqual(['connections.taint-guard']);
    expect(itemIdsForSettingsPaths(['nothingHere'])).toEqual([]);
    expect(itemIdsForBotPaths(['runtime.model'])).toEqual(['bot.model']);
    expect(itemIdsForBotPaths(['runtime'])).toContain('bot.network');
    expect(itemIdsForServiceMethod('projects.update')).toEqual(['project.title', 'project.goal']);
    expect(itemIdsForServiceMethod('unattended.enable')).toEqual(['unattended.enable']);
  });

  it('declares settings paths that exist in settingsSchema', () => {
    const defaults = settingsSchema.parse({}) as Record<string, unknown>;
    for (const entry of items) {
      if (entry.store.kind !== 'settings') continue;
      for (const path of entry.store.paths) {
        let node: unknown = defaults;
        for (const key of path.split('.')) {
          // backgroundAgentId 是 optional（缺省 undefined），只检查键在 schema 形状里。
          expect(node !== null && typeof node === 'object', `${entry.id}:${path}`).toBe(true);
          const shapeHas =
            key in (node as Record<string, unknown>) ||
            (path === 'backgroundAgentId' && key === 'backgroundAgentId');
          expect(shapeHas, `${entry.id}:${path}`).toBe(true);
          node = (node as Record<string, unknown>)[key];
        }
      }
    }
  });
});

describe('UI coverage (§4.3 测试一 / 测试二 shared 部分)', () => {
  const scan = scanSettingsUi();

  it('scans the real settings UI', () => {
    // 宽松扫描也必须扫到已知位置，否则说明扫描规则失效。
    expect(scan.settingsSections).toEqual(
      expect.arrayContaining(['general', 'models', 'apps']),
    );
    expect(scan.anchors).toEqual(
      expect.arrayContaining(['default-models', 'web-search', 'apps-connected', 'agent-*']),
    );
    expect(scan.anchorSections['default-models']).toBe('models');
    expect(scan.extensionCenterTabs).toEqual(['skills', 'connections', 'mcp', 'mail']);
    expect(scan.botPanelTabs).toEqual(expect.arrayContaining(['profile', 'skills', 'schedules']));
  });

  it('every settings location has an item or an exclusion; every deep link lands', () => {
    expect(settingsCoverageProblems(scan)).toEqual([]);
  });

  it('flags a new unregistered section / anchor / tab and a dead deep link', () => {
    const grown: SettingsUiScan = {
      ...scan,
      settingsSections: [...scan.settingsSections, 'brand-new'],
      anchors: [...scan.anchors, 'brand-new-anchor'],
      extensionCenterTabs: [...scan.extensionCenterTabs, 'store'],
      botPanelTabs: [...scan.botPanelTabs, 'insights'],
    };
    const problems = settingsCoverageProblems(grown);
    expect(problems.some((line) => line.includes('brand-new'))).toBe(true);
    expect(problems.some((line) => line.includes('brand-new-anchor'))).toBe(true);
    expect(problems.some((line) => line.includes('store'))).toBe(true);
    expect(problems.some((line) => line.includes('insights'))).toBe(true);

    const dead: SettingItem = {
      ...getSettingItem('models.default-main')!,
      id: 'models.dead-link',
      deepLink: { surface: 'settings', section: 'models', anchor: 'models-default' },
    };
    expect(
      settingsCoverageProblems(scan, { items: [...items, dead] }).some((line) =>
        line.includes('models-default'),
      ),
    ).toBe(true);
    const misplaced: SettingItem = {
      ...dead,
      deepLink: { surface: 'settings', section: 'search', anchor: 'default-models' },
    };
    expect(settingsCoverageProblems(scan, { items: [...items, misplaced] })).toEqual([
      'models.dead-link：锚点 default-models 在分区 models，深链却写 search',
    ]);
  });

  it('pending anchors are still missing in the UI (delete them once the desktop adds them)', () => {
    for (const anchor of PENDING_DESKTOP_ANCHORS) expect(scan.anchors).not.toContain(anchor);
    // 登记为待补、界面上却已经有了：提示删掉登记（desktop 已补齐 bot-model，借它构造）。
    expect(scan.anchors).toContain('bot-model');
    expect(
      settingsCoverageProblems(scan, { pendingAnchors: [...PENDING_DESKTOP_ANCHORS, 'bot-model'] }),
    ).toEqual([
      '待补锚点 bot-model 已存在：从 PENDING_DESKTOP_ANCHORS 删掉',
    ]);
  });

  it('exclusions explain themselves and point at live locations', () => {
    for (const entry of EXCLUDED_SETTING_LOCATIONS) expect(entry.reason.length).toBeGreaterThan(4);
    const shrunk: SettingsUiScan = {
      ...scan,
      botPanelTabs: scan.botPanelTabs.filter((tab) => tab !== 'wiki'),
    };
    expect(settingsCoverageProblems(shrunk)).toEqual([
      '排除表的 bot-panel-tab wiki 在界面上已不存在',
    ]);
  });
});

describe('store.generic discipline (todo/settings-catalog-registry.md §4.2.4)', () => {
  it('generic items are plain top-level scalars: no sensitive / multiple / nested / widening', () => {
    const generic = items.filter(
      (entry) => entry.store.kind === 'settings' && entry.store.generic === true,
    );
    expect(generic.map((entry) => entry.id)).toEqual(['general.workbench']);
    const defaults = settingsSchema.parse({}) as Record<string, unknown>;
    for (const entry of generic) {
      expect(entry.owner, entry.id).toBe('core');
      expect(entry.scope, entry.id).toBe('global');
      expect(entry.write.via, entry.id).toBe('catalog');
      expect(entry.write.widensPermission, entry.id).toBe(false);
      expect(entry.write.wideningMode, entry.id).toBeUndefined();
      for (const field of entry.fields) {
        const path = field.path ?? field.name;
        expect(field.sensitive, `${entry.id}.${field.name}`).toBe(false);
        expect(field.multiple, `${entry.id}.${field.name}`).not.toBe(true);
        expect(path.includes('.'), `${entry.id}.${field.name} path 应为顶层键`).toBe(false);
        expect(path in defaults, `${entry.id}.${field.name} path 应是 settingsSchema 的顶层键`).toBe(true);
      }
    }
  });
});

describe('renderer component map check (for the desktop lane)', () => {
  it('passes for a complete map and names missing / unknown keys', () => {
    expect(cardComponentProblems(CARD_KEYS)).toEqual([]);
    const partial = CARD_KEYS.filter((key) => key !== 'sensor');
    expect(cardComponentProblems([...partial, 'bogus'])).toEqual([
      '卡片键 sensor 在渲染层映射里没有组件',
      '渲染层映射里的 bogus 不是 CARD_KEYS 里的卡片键',
    ]);
  });
});

describe('adapter coverage (todo/settings-catalog-registry.md §4.1.4)', () => {
  const writableCore = (id: string, extra: Partial<SettingItem> = {}): SettingItem => ({
    ...getSettingItem('general.workbench')!,
    id,
    // 显式去掉 generic：这个助手要构造「需要适配器」的条目（workbench 本身已豁免）。
    store: { kind: 'settings', paths: ['demoFlag'] },
    ...extra,
  });

  it('requires adapters for core-owned catalog-writable items and flags missing ones', () => {
    const item = writableCore('general.demo-toggle');
    const problems = settingsAdapterCoverageProblems({
      items: [item],
      adapterIds: [],
    });
    expect(problems).toEqual([
      'general.demo-toggle：需要 core 适配器（core 拥有、经目录写入），但不在贡献表里，也没有登记 EXPLICIT_ADAPTER_FALLBACK 理由',
    ]);
    expect(settingsAdapterCoverageProblems({ items: [item], adapterIds: ['general.demo-toggle'] })).toEqual(
      [],
    );
  });

  it('exempts read-only / renderer / via-tool / generic items', () => {
    const items = [
      getSettingItem('diagnostics.status')!, // readOnly
      getSettingItem('general.theme')!, // renderer
      getSettingItem('mail.account')!, // via tool
      { ...getSettingItem('general.workbench')!, store: { kind: 'settings', paths: ['workbenchEnabled'], generic: true } },
    ];
    expect(settingsAdapterCoverageProblems({ items, adapterIds: [] })).toEqual([]);
  });

  it('flags stale adapter registrations and explicit fallback leftovers', () => {
    const items = [writableCore('general.demo-toggle')];
    expect(
      settingsAdapterCoverageProblems({ items, adapterIds: ['general.demo-toggle', 'general.gone'] }),
    ).toEqual(['适配器贡献登记了不存在的条目 general.gone']);
    expect(
      settingsAdapterCoverageProblems({
        items,
        adapterIds: ['general.demo-toggle'],
        explicitFallback: { 'general.demo-toggle': '已有适配器却登记 fallback' },
      }),
    ).toEqual(['EXPLICIT_ADAPTER_FALLBACK 里的 general.demo-toggle 已有适配器，fallback 是遗留']);
    expect(
      settingsAdapterCoverageProblems({
        items,
        adapterIds: [],
        explicitFallback: {
          'general.demo-toggle': '先用 fallback 占位',
          'general.no-such': '条目不存在',
        },
      }),
    ).toEqual(['EXPLICIT_ADAPTER_FALLBACK 里的 general.no-such 不是目录条目']);
  });

  it('accepts a justified explicit fallback for an otherwise-uncovered item', () => {
    expect(
      settingsAdapterCoverageProblems({
        items: [writableCore('general.demo-toggle')],
        adapterIds: [],
        explicitFallback: { 'general.demo-toggle': '没有安全信号，读状态以设置页为准' },
      }),
    ).toEqual([]);
  });

  it('accepts field path and store generic in the schema', () => {
    const item = getSettingItem('general.task-loop')!;
    expect(
      settingItemSchema.safeParse({
        ...item,
        fields: [{ ...item.fields[0]!, path: 'taskLoop.idleGuardEnabled' }],
      }).success,
    ).toBe(true);
    expect(
      settingItemSchema.safeParse({
        ...getSettingItem('general.workbench')!,
        store: { kind: 'settings', paths: ['workbenchEnabled'], generic: true },
      }).success,
    ).toBe(true);
  });
});


describe('general.task-loop catalog + settings schema (D93)', () => {
  it('registers the task-loop item, fields and deep link', () => {
    const item = getSettingItem('general.task-loop');
    expect(item).not.toBeNull();
    expect(item?.store).toEqual({ kind: 'settings', paths: ['taskLoop'] });
    expect(item?.card).toBe('field-editor');
    expect(item?.write.maxMode).toBe('confirm');
    expect(item?.deepLink).toEqual({
      surface: 'settings',
      section: 'general',
      anchor: 'general-task-loop',
    });
    expect(item?.fields.map((field) => [field.name, field.type])).toEqual([
      ['idleGuardEnabled', 'toggle'],
      ['idleWarnAfter', 'number'],
      ['idleStopAfter', 'number'],
      ['idleWindowCalls', 'number'],
      ['tokenSoftBudget', 'number'],
    ]);
    expect(item?.fields.find((field) => field.name === 'idleWarnAfter')).toMatchObject({
      min: 2,
      max: 10,
      step: 1,
    });
    expect(itemIdsForSettingsPaths(['taskLoop'])).toContain('general.task-loop');
  });

  it('defaults missing values and falls back to defaults on broken stored data', () => {
    expect(settingsSchema.parse({}).taskLoop).toEqual({
      idleGuardEnabled: true,
      idleWarnAfter: 3,
      idleStopAfter: 6,
      idleWindowCalls: 12,
      tokenSoftBudget: 0,
    });
    expect(settingsSchema.parse({ taskLoop: { idleWarnAfter: 4 } }).taskLoop).toMatchObject({
      idleWarnAfter: 4,
      idleStopAfter: 6,
      idleWindowCalls: 12,
      tokenSoftBudget: 0,
    });
    // 读取容错：损坏的旧数据回落到默认值，而不是让整份设置解析失败。
    expect(settingsSchema.parse({ taskLoop: { idleWarnAfter: 99 } }).taskLoop).toMatchObject({
      idleWarnAfter: 3,
      idleStopAfter: 6,
    });
  });

  it('keeps the update input strict (no silent clamping)', () => {
    const parsed = settingsUpdateInputSchema.parse({
      taskLoop: {
        idleGuardEnabled: false,
        idleWarnAfter: 4,
        idleStopAfter: 8,
        idleWindowCalls: 10,
        tokenSoftBudget: 100_000,
      },
    });
    expect(parsed.taskLoop).toMatchObject({ idleWarnAfter: 4, idleStopAfter: 8 });
    expect(() =>
      settingsUpdateInputSchema.parse({ taskLoop: { idleWarnAfter: 99 } }),
    ).toThrow();
  });
});

describe('general.workbench catalog + update schema (D90)', () => {
  it('workbenchEnabled defaults off and settings.update keeps the boolean', () => {
    expect(settingsSchema.parse({}).workbenchEnabled).toBe(false);
    expect(settingsSchema.parse({}).workbenchNudgeDismissed).toBe(false);
    const item = getSettingItem('general.workbench');
    expect(item?.store).toEqual({ kind: 'settings', paths: ['workbenchEnabled'], generic: true });
    expect(itemIdsForSettingsPaths(['workbenchEnabled'])).toContain('general.workbench');
    const parsed = settingsUpdateInputSchema.parse({ workbenchEnabled: true });
    expect(parsed.workbenchEnabled).toBe(true);
    expect(
      settingsSchema.parse({ ...settingsSchema.parse({}), workbenchEnabled: true }).workbenchEnabled,
    ).toBe(true);
  });
});
