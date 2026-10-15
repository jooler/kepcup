<script lang="ts">
  /**
   * 当前用户头像占位（尚无个人资料头像）。群聊马赛克与侧栏菜单共用；
   * 之后接上真实头像时只改本组件即可。
   */
  import { t } from '$lib/i18n';

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
</script>

<span
  class="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-muted-foreground {klass}"
  style={shadowVars}
  data-testid={testId}
  aria-hidden="true"
>
  <span
    class="select-none text-[0.55em] font-semibold leading-none {glyphShadowOffset
      ? 'group-avatar-letter-shadow'
      : ''}">{t('sidebar.userFallback')}</span
  >
</span>
