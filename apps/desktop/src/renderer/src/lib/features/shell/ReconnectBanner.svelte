<script lang="ts">
  import { t } from '$lib/i18n';
</script>

<div
  class="app-no-drag pointer-events-none flex w-full max-w-xl items-center justify-center gap-3
    rounded-full border border-amber-700/40 bg-amber-500 px-4 py-1.5 text-sm font-medium text-white
    shadow-lg"
  data-testid="reconnect-banner"
  role="status"
>
  {t('shell.reconnecting')}
</div>
