/**
 * 设置页「默认主/轻量模型」本地草稿与 settings store 的同步策略。
 *
 * `$effect` 若在每次 settings 引用变化时都 `mainModel = settings.defaultMainModel`，
 * 一次无关的 `settingsStore.refresh()`（或其它字段的 update）会把下拉框里尚未点
 * 「保存」的选择冲回旧值；再点保存等于没改。只在 store 里该字段相对「上次从
 * store 应用的值」真的变了时才写入本地。
 */
export function nextLocalFromStore(input: {
  storeValue: string;
  lastApplied: string | null;
  localValue: string;
}): { localValue: string; lastApplied: string } {
  if (input.lastApplied === null || input.storeValue !== input.lastApplied) {
    return { localValue: input.storeValue, lastApplied: input.storeValue };
  }
  return { localValue: input.localValue, lastApplied: input.lastApplied };
}
