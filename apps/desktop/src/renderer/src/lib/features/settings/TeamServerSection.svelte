<script lang="ts">
  import { t } from '$lib/i18n';
  import TeamServerConnectCard from '$lib/features/team/TeamServerConnectCard.svelte';

  /**
   * 设置页「团队服务器」独立分区：连接团队服务器 = 连接远端的 KepCup（远程
   * 执行中心），与「远程遥控」（手机遥控本机）是两件事，独立成组。主体就是
   * 连接卡（地址 / 健康检查 / 登录 / 多账号 / 融合开关），桌面端点才可见
   *（分区导航由 settings-section-labels 按 platform.teamServers 能力插入）。
   */
</script>

<div class="space-y-6">
  <div>
    <h3 class="text-base font-medium">{t('settings.teamServerSectionTitle')}</h3>
    <p class="mt-1 text-sm text-muted-foreground">{t('settings.teamServerSectionHint')}</p>
  </div>
  <div data-settings-anchor="team-server-connection">
    <TeamServerConnectCard />
  </div>
</div>
