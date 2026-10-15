<script lang="ts">
  import { Users } from '@lucide/svelte';
  import * as Avatar from '$lib/components/ui/avatar';
  import BotAvatar from './BotAvatar.svelte';
  import { GROUP_MEMBER_PREVIEW_MAX } from '@kepcup/shared';
  import { groupAvatarSlots } from './group-avatar-layout';

  let {
    members,
    class: klass = 'size-10',
  }: {
    members: Array<{ id: string; name: string; avatar?: string | null }>;
    class?: string;
  } = $props();

  const shown = $derived(members.slice(0, GROUP_MEMBER_PREVIEW_MAX));
  const seed = $derived(shown.map((member) => member.id).join('|'));
  const slots = $derived(groupAvatarSlots(shown.length, seed));
</script>

{#if members.length === 0}
  <Avatar.Root class={klass}>
    <Avatar.Fallback
      data-testid="group-avatar-stack"
      class="bg-emerald-600 text-primary-foreground"
    >
      <Users class="size-5" aria-hidden="true" />
    </Avatar.Fallback>
  </Avatar.Root>
{:else}
  <span
    class="relative inline-block shrink-0 {klass}"
    data-testid="group-avatar-stack"
    aria-hidden="true"
  >
    {#each shown as member, index (member.id)}
      {@const slot = slots[index]}
      {#if slot}
        <span
          class="absolute overflow-hidden rounded-full"
          style="left:{slot.x}%; top:{slot.y}%; width:{slot.size}%; height:{slot.size}%; transform:translate(-50%,-50%); z-index:{slot.z};"
        >
          <BotAvatar
            botId={member.id}
            name={member.name}
            avatar={member.avatar ?? null}
            class="size-full"
            animated={false}
          />
        </span>
      {/if}
    {/each}
  </span>
{/if}
