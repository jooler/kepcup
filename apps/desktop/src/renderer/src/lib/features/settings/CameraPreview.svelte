<script lang="ts">
  import { onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import { sensors } from '$lib/sensors/sensors.svelte';
  import { SensorDisabledError } from '$lib/sensors/types';

  /**
   * 摄像头预览（docs/design/31-sensors.md §2.3，D76 本期唯一的摄像头功能）：
   * 用户点击才打开设备；关闭 / 停用 / 离开分区（卸载）立即 track.stop() 并清
   * srcObject。srcObject 直接挂 MediaStream，不经 URL，现有 CSP 无需放宽。
   */

  const enabled = $derived(sensors.state.camera.enabled);
  let previewing = $state(false);
  let error = $state<string | null>(null);
  let video = $state<HTMLVideoElement | null>(null);
  let stream: MediaStream | null = null;
  let session = 0;

  function release(): void {
    session += 1;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    if (video !== null) video.srcObject = null;
    previewing = false;
  }

  async function start(): Promise<void> {
    error = null;
    const mine = ++session;
    try {
      const access = await sensors.ensureAccess('camera');
      if (mine !== session) return;
      if (access !== 'granted') {
        error = t('sensors.testAccessFailed');
        return;
      }
      const opened = await sensors.open('camera');
      if (mine !== session) {
        for (const track of opened.stream.getTracks()) track.stop();
        return;
      }
      stream = opened.stream;
      previewing = true;
      // 授权后设备名才可见：预览成功后刷新一次列表。
      void sensors.refresh('camera');
    } catch (cause) {
      release();
      error =
        cause instanceof SensorDisabledError
          ? t('sensors.testDisabled')
          : t('sensors.testFailed', {
              reason: cause instanceof Error ? cause.message : String(cause),
            });
    }
  }

  // <video> 挂载后接上流。
  $effect(() => {
    if (video !== null && stream !== null && previewing) {
      video.srcObject = stream;
      void video.play().catch(() => {});
    }
  });
  // 预览中被停用 → 立即释放。
  $effect(() => {
    if (!enabled && previewing) release();
  });
  onDestroy(release);
</script>

<div class="space-y-2" data-testid="sensor-test-camera">
  <Button
    variant="outline"
    size="sm"
    disabled={!enabled}
    onclick={() => (previewing ? release() : void start())}
    data-testid="sensor-test-toggle-camera"
  >
    {previewing ? t('sensors.camera.stopPreview') : t('sensors.camera.preview')}
  </Button>
  {#if !enabled}
    <p class="text-xs text-muted-foreground">{t('sensors.camera.enableFirst')}</p>
  {/if}
  {#if previewing}
    <video
      bind:this={video}
      autoplay
      muted
      playsinline
      class="aspect-video w-full rounded-md bg-black object-contain"
      data-testid="sensor-preview-camera"
    ></video>
  {/if}
  {#if error !== null}
    <p class="text-xs text-destructive" data-testid="sensor-test-error-camera">{error}</p>
  {/if}
</div>
