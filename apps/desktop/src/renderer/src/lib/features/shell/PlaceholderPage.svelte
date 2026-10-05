<script lang="ts">
  let {
    title,
    message,
    testid = 'placeholder-page',
  }: { title: string; message: string; testid?: string } = $props();
</script>

<div class="app-drag flex h-full flex-1 items-center justify-center p-8" data-testid={testid}>
  <div class="text-center">
    <h1 class="text-lg font-semibold">{title}</h1>
    {#if message}
      <p class="mt-2 text-sm text-muted-foreground">{message}</p>
    {/if}
  </div>
</div>
