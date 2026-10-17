<script lang="ts">
  /**
   * 当前用户头像占位（尚无个人资料头像）。项目组马赛克与侧栏菜单共用；
   * 之后接上真实头像时只改本组件即可。字号按头像边长走（cqmin），em 只认继承字号，
   * 不会随 size-* 变。
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
  class="[container-type:size] inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-muted-foreground {klass}"
  style={shadowVars}
  data-testid={testId}
  aria-hidden="true"
>
  <span
    class="[font-size:35cqmin] leading-none font-semibold select-none {glyphShadowOffset
      ? 'group-avatar-letter-shadow'
      : ''}">{t('sidebar.userFallback')}</span
  >
</span>
