<script lang="ts">
  import { onMount } from 'svelte';
  import { SENSOR_KINDS } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { sensors } from '$lib/sensors/sensors.svelte';
  import SensorCard from './SensorCard.svelte';

  /**
   * 设置页「硬件」分区（docs/design/31-sensors.md §2.3，D76）：按传感器注册表
   * 数据驱动渲染，每个 kind 一张卡片（启用 / 设备 / 权限 / 测试）。设备偏好是
   * 渲染层本机偏好（localStorage），不进 core 用户数据；设备热插拔由 sensors
   * store 监听 devicechange 自动刷新。
   */

  onMount(() => {
    void sensors.refreshAll();
  });
</script>

<section class="space-y-6" data-testid="settings-hardware">
  <h3 class="text-sm font-medium">{t('settings.hardwareSection')}</h3>
  {#each SENSOR_KINDS as descriptor (descriptor.id)}
    <SensorCard kind={descriptor.id} />
  {/each}
</section>
