<script lang="ts">
  /**
   * 当前用户头像：设置了头像（settings.userProfileAvatar = `upload:{fileName}`）时
   * 渲染该图（dataURL 经 avatarImages 缓存），否则回退到占位字母。项目组马赛克与
   * 侧栏菜单共用。字号按头像边长走（cqmin），em 只认继承字号，不会随 size-* 变。
   */
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { avatarImages } from './avatar-images.svelte';

  let {
    class: klass = 'size-8',
    testId = 'user-avatar',
    glyphShadowOffset = null,
  }: {
    class?: string;
    testId?: string;
    /** 字影：1px 朝向群头像中心；null 表示无投影。 */
    glyphShadowOffset?: { x: number; y: number } | null;
  } = $props();

  const shadowVars = $derived(
    glyphShadowOffset === null
      ? undefined
      : `--group-avatar-sx:${glyphShadowOffset.x}px; --group-avatar-sy:${glyphShadowOffset.y}px`,
  );

  /** `upload:{fileName}` → 文件名；'' / 其他形态都没有自传头像。 */
  const uploadedFile = $derived.by(() => {
    const ref = settingsStore.settings?.userProfileAvatar ?? '';
    return ref.startsWith('upload:') ? ref.slice('upload:'.length) : null;
  });
  const avatarUrl = $derived(uploadedFile !== null ? avatarImages.user(uploadedFile) : null);
</script>

<span
  class="[container-type:size] inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-muted-foreground {klass}"
  style={shadowVars}
  data-testid={testId}
  aria-hidden="true"
>
  {#if avatarUrl !== null}
    <img src={avatarUrl} alt="" class="size-full object-cover" draggable="false" />
  {:else}
    <span
      class="[font-size:35cqmin] leading-none font-semibold select-none {glyphShadowOffset
        ? 'group-avatar-letter-shadow'
        : ''}">{t('sidebar.userFallback')}</span
    >
  {/if}
</span>
