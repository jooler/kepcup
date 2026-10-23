/**
 * 配对二维码小窗的打开请求（D96）：设置页按钮与托盘入口（经 App.svelte 的
 * preload 监听）都汇聚到这里；小窗实例订阅 `request` 拉起自己。
 */
export const remotePairing = (() => {
  let pending = $state(false);
  return {
    get pending() {
      return pending;
    },
    request() {
      pending = true;
    },
    consume() {
      pending = false;
    },
  };
})();
