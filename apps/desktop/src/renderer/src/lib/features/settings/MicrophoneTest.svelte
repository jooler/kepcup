<script lang="ts">
  import { onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import { levelToHeight } from '$lib/features/chats/voice-recorder';
  import { sensors } from '$lib/sensors/sensors.svelte';
  import { SensorDisabledError } from '$lib/sensors/types';

  /**
   * 麦克风测试（docs/design/31-sensors.md §2.3）：点击才打开设备，电平条实时
   * 起伏；再点 / 停用 / 离开分区（组件卸载）即释放轨道，不在后台持有设备。
   */

  const enabled = $derived(sensors.state.microphone.enabled);
  let testing = $state(false);
  let level = $state(0);
  let error = $state<string | null>(null);

  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let frame: number | null = null;
  // 防止 await 期间被停止 / 卸载后仍把设备挂着。
  let session = 0;

  function release(): void {
    session += 1;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    void context?.close().catch(() => {});
    context = null;
    testing = false;
    level = 0;
  }

  async function start(): Promise<void> {
    error = null;
    const mine = ++session;
    try {
      const access = await sensors.ensureAccess('microphone');
      if (mine !== session) return;
      if (access !== 'granted') {
        error = t('sensors.testAccessFailed');
        return;
      }
      const opened = await sensors.open('microphone');
      if (mine !== session) {
        for (const track of opened.stream.getTracks()) track.stop();
        return;
      }
      stream = opened.stream;
      const ctx = new AudioContext();
      context = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(opened.stream).connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);
      const tick = (): void => {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (const sample of buffer) sum += sample * sample;
        level = levelToHeight(Math.sqrt(sum / buffer.length));
        frame = requestAnimationFrame(tick);
      };
      testing = true;
      tick();
      // 授权后设备名才可见：测试成功后刷新一次列表。
      void sensors.refresh('microphone');
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

  // 测试中被停用 → 立即释放。
  $effect(() => {
    if (!enabled && testing) release();
  });
  onDestroy(release);
</script>

<div class="space-y-2" data-testid="sensor-test-microphone">
  <div class="flex items-center gap-3">
    <Button
      variant="outline"
      size="sm"
      disabled={!enabled}
      onclick={() => (testing ? release() : void start())}
      data-testid="sensor-test-toggle-microphone"
    >
      {testing ? t('sensors.stopTest') : t('sensors.microphone.test')}
    </Button>
    <div class="h-2 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
      <div
        class="h-full bg-primary transition-[width] duration-75"
        style:width="{Math.round(level * 100)}%"
        data-testid="sensor-level-microphone"
      ></div>
    </div>
  </div>
  {#if error !== null}
    <p class="text-xs text-destructive" data-testid="sensor-test-error-microphone">{error}</p>
  {/if}
</div>
