import { detectLocale } from './locale-detect';
import { enUS } from './locales/en-US';
import { zhCN, type MessageKey } from './locales/zh-CN';

/**
 * 语言注册表（响应式状态必须在 .svelte.ts 中，$state 才会被编译）。
 * 新增语言时在 `locales/` 加词典文件并在此注册一行即可，设置弹框的
 * 语言选择器会自动出现新选项，无需改动任何组件。
 */
export interface LocaleOption {
  id: string;
  label: string;
}

const dicts: Record<string, Partial<Record<MessageKey, string>>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

export const localeOptions: LocaleOption[] = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'en-US', label: 'English' },
];

const LOCALE_STORAGE_KEY = 'kepcup.locale';

export { detectLocale, type LocaleId } from './locale-detect';

function initialLocale(): string {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored && stored in dicts) return stored;
  } catch {
    // localStorage 不可用时按系统语言推断
  }
  return detectLocale();
}

function applyDocumentLang(locale: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

class I18nState {
  /** 当前语言；t() 读取它，因此所有模板文案随语言切换响应式更新。 */
  #locale = $state(initialLocale());

  get locale(): string {
    return this.#locale;
  }

  /** 赋值即生效并持久化（bind:value 可直接绑定）。 */
  set locale(next: string) {
    this.setLocale(next);
  }

  setLocale(locale: string): void {
    if (!(locale in dicts)) return;
    this.#locale = locale;
    applyDocumentLang(locale);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // 持久化失败只影响下次启动的默认语言
    }
  }
}

export const i18n = new I18nState();
applyDocumentLang(i18n.locale);

/** 取当前语言的文案；缺 key 时回退到 zh-CN，再缺失时原样返回 key。 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const dict = dicts[i18n.locale] ?? {};
  const template = dict[key] ?? zhCN[key];
  if (template === undefined) return key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in params ? String(params[name]) : `{${name}}`,
  );
}

/** 列表连接符（中文顿号 / 英文逗号）。 */
export function listSeparator(): string {
  return i18n.locale === 'en-US' ? ', ' : '、';
}

/** Looks up a dynamic key (settings-catalog copy) in the current locale, then zh-CN. */
function lookup(key: string): string | undefined {
  const current = dicts[i18n.locale] ?? {};
  return current[key as MessageKey] ?? zhCN[key as MessageKey];
}

/** 设置目录条目的标题 / 说明：渲染层按 key 覆盖，缺省回退目录里的中文。 */
export function settingItemText(
  itemId: string,
  part: 'title' | 'summary',
  fallback: string,
): string {
  return lookup(`settingsItem.${itemId}.${part}`) ?? fallback;
}

/** 设置目录字段名：按条目 + 字段名翻译，缺省回退目录里的中文。 */
export function settingFieldText(itemId: string, fieldName: string, fallback: string): string {
  return lookup(`settingsItem.${itemId}.field.${fieldName}`) ?? fallback;
}

/** 设置目录字段提示：按条目 + 字段名翻译，缺省回退目录里的中文。 */
export function settingFieldHint(itemId: string, fieldName: string, fallback: string): string {
  return lookup(`settingsItem.${itemId}.field.${fieldName}.hint`) ?? fallback;
}

/** 设置目录静态选项名：按条目 + 字段 + 值翻译，缺省回退目录里的中文。 */
export function settingOptionText(
  itemId: string,
  fieldName: string,
  value: string,
  fallback: string,
): string {
  return lookup(`settingsItem.${itemId}.option.${fieldName}.${value}`) ?? fallback;
}

/** 沙箱状态原因（core 生成的中文说明）→ 当前语言；认不出的原样返回。 */
export function sandboxReasonText(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined || reason.length === 0) return null;
  if (reason.includes('未安装 Lima')) return t('sandbox.reason.limaMissing');
  if (reason.includes('Lima 已安装但增强沙箱虚拟机尚未创建')) {
    return t('sandbox.reason.limaNotCreated');
  }
  if (reason.includes('增强沙箱虚拟机未在运行')) return t('sandbox.reason.vmNotRunning');
  if (reason.includes('增强沙箱镜像尚未导入')) return t('sandbox.reason.imageMissing');
  if (reason.includes('未安装 rootless Podman')) return t('sandbox.reason.podmanMissing');
  const platform = /^当前平台（(.+)）暂不支持沙箱/.exec(reason);
  if (platform !== null) return t('sandbox.reason.platformUnsupported', { platform: platform[1]! });
  const depsMissing = /^沙箱依赖缺失：(.+)$/.exec(reason);
  if (depsMissing !== null) return t('sandbox.reason.depsMissing', { deps: depsMissing[1]! });
  const depsCheck = /^沙箱依赖检测失败：(.+)$/.exec(reason);
  if (depsCheck !== null) return t('sandbox.reason.depsCheckFailed', { error: depsCheck[1]! });
  const selfTest = /^沙箱自检命令失败（退出码 (.+)）$/.exec(reason);
  if (selfTest !== null) return t('sandbox.reason.selfTestFailed', { code: selfTest[1]! });
  const init = /^沙箱初始化失败：(.+)$/.exec(reason);
  if (init !== null) return t('sandbox.reason.initFailed', { error: init[1]! });
  const wslMissing = /^WSL2 未安装（(.+)）$/.exec(reason);
  if (wslMissing !== null) return t('sandbox.reason.wslMissing', { detail: wslMissing[1]! });
  const wslDisabled = /^WSL2 组件未启用（(.+)）$/.exec(reason);
  if (wslDisabled !== null) return t('sandbox.reason.wslDisabled', { detail: wslDisabled[1]! });
  const wsl1 = /^(.+) 发行版被注册为 WSL1/.exec(reason);
  if (wsl1 !== null) return t('sandbox.reason.wsl1', { distro: wsl1[1]! });
  if (reason.includes('管理员授权已完成，请重启 Windows 后继续')) {
    return t('sandbox.reason.wslReboot');
  }
  if (reason.includes('WSL 启用命令已完成')) return t('sandbox.reason.wslEnableReboot');
  if (reason.includes('WSL2 已就绪，应用私有发行版尚未导入')) {
    return t('sandbox.reason.wslDistroMissing');
  }
  if (reason.includes('发行版配置未完成')) return t('sandbox.reason.wslConfigIncomplete');
  return reason;
}

/** 连接应用目录条目：按 connector slug 覆盖描述，缺省回退目录数据。 */
export function connectorDescription(connectorId: string, fallback: string): string {
  return lookup(`connector.${connectorId}.description`) ?? fallback;
}

/** 连接应用不可连接原因：把 core 的中文原因映射到当前语言，认不出时原样返回。 */
export function connectorUnavailableText(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined || reason.length === 0) return null;
  if (reason.includes('没有可用的远程端点')) return t('apps.unavailable.noRemote');
  const auth = /^暂不支持 (.+) 认证方式$/.exec(reason);
  if (auth !== null) return t('apps.unavailable.unsupportedAuth', { kind: auth[1]! });
  const preregistered = /预注册的客户端（(.+?)）/.exec(reason);
  if (preregistered !== null) {
    return t('apps.unavailable.preregisteredClient', { ref: preregistered[1]! });
  }
  return reason;
}

/** 预置技能卡片：按 preset id + 字段覆盖，缺省回退目录数据。 */
export function presetSkillText(
  id: string,
  part: 'name' | 'summary' | 'tryIt',
  fallback: string,
): string {
  return lookup(`presetSkill.${id}.${part}`) ?? fallback;
}

/** 内置厂商展示名（阿里云百炼 / 火山方舟）：按 vendor id 翻译。 */
export function vendorName(id: string, fallback: string): string {
  return lookup(`settings.vendor.${id}`) ?? fallback;
}

/** 外部智能体目录描述 / 登录说明：按 agent id 翻译。 */
export function agentText(id: string, part: 'description' | 'authNote', fallback: string): string {
  return lookup(`agent.${id}.${part}`) ?? fallback;
}

/** Maps an RPC error code to user-facing text (current locale). */
export function errorText(code: string | undefined, fallback: string): string {
  if (code === undefined) return fallback;
  const key = `chats.errorCode.${code}` as MessageKey;
  return key in (dicts[i18n.locale] ?? {}) || key in zhCN ? t(key) : fallback;
}
