import { core } from '$lib/rpc/client.svelte';

/**
 * 上传头像的 dataURL 缓存（key = `{botId}/{fileName}`）。文件名带时间戳，
 * 新上传自然换 key；旧文件被 core 删除后读取会 404，失败结果记入
 * `#failed`，避免渲染反复重发注定失败的 RPC。
 */
class AvatarImageStore {
  #cache = $state<Record<string, string>>({});
  #pending = new Set<string>();
  #failed = new Set<string>();

  url(botId: string, file: string): string | null {
    const key = `${botId}/${file}`;
    const cached = this.#cache[key];
    if (cached) return cached;
    if (!this.#pending.has(key) && !this.#failed.has(key)) {
      this.#pending.add(key);
      core
        .call('bots.avatar.data', { id: botId, file })
        .then((data) => {
          const { mime, base64 } = data as { mime: string; base64: string };
          this.#cache = { ...this.#cache, [key]: `data:${mime};base64,${base64}` };
        })
        .catch(() => {
          this.#failed.add(key);
        })
        .finally(() => {
          this.#pending.delete(key);
        });
    }
    return null;
  }
}

export const avatarImages = new AvatarImageStore();
