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
};

export const localeOptions: LocaleOption[] = [{ id: 'zh-CN', label: '简体中文' }];

const LOCALE_STORAGE_KEY = 'kepcup.locale';

function initialLocale(): string {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored && stored in dicts) return stored;
  } catch {
    // localStorage 不可用时用默认语言
  }
  return 'zh-CN';
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
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // 持久化失败只影响下次启动的默认语言
    }
  }
}

export const i18n = new I18nState();

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

/** Maps an RPC error code to user-facing text (current locale). */
export function errorText(code: string | undefined, fallback: string): string {
  if (code === undefined) return fallback;
  const key = `chats.errorCode.${code}` as MessageKey;
  return key in (dicts[i18n.locale] ?? {}) || key in zhCN ? t(key) : fallback;
}
