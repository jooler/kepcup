<script lang="ts">
  import { t } from '$lib/i18n';
</script>

<div
  class="flex h-9 items-center justify-center bg-amber-100 text-sm text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
  data-testid="reconnect-banner"
  role="status"
>
  {t('shell.reconnecting')}
</div>
