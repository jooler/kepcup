<script lang="ts">
  import { Users } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import * as Avatar from '$lib/components/ui/avatar';
  import BotAvatar from './BotAvatar.svelte';
  import UserAvatar from './UserAvatar.svelte';
  import { GROUP_MEMBER_PREVIEW_MAX } from '@kepcup/shared';
  import {
    GROUP_AVATAR_USER_ID,
    groupAvatarSlots,
    shadowOffsetTowardCenter,
  } from './group-avatar-layout';

  let {
    members,
    class: klass = 'size-10',
    includeUser = true,
  }: {
    members: Array<{ id: string; name: string; avatar?: string | null }>;
    class?: string;
    /** 群聊始终含当前用户；个别场景可关掉。 */
    includeUser?: boolean;
  } = $props();

  const faces = $derived.by(() => {
    const bots = members.filter((member) => member.id !== GROUP_AVATAR_USER_ID);
    if (!includeUser) return bots;
    return [
      {
        id: GROUP_AVATAR_USER_ID,
        name: t('sidebar.userName'),
        avatar: null as string | null,
      },
      ...bots,
    ];
  });
  // 与 core 下发的成员预览同一上限：多了既看不清，也白渲染。
  const shown = $derived(faces.slice(0, GROUP_MEMBER_PREVIEW_MAX));
  const seed = $derived(shown.map((member) => member.id).join('|'));
  const slots = $derived(groupAvatarSlots(shown.length, seed));
</script>

{#if faces.length === 0}
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
        {@const shadow = shadowOffsetTowardCenter(slot)}
        <!-- 不裁切瓦片：字影 drop-shadow / text-shadow 需要略微溢出；圆形由子头像自己裁。 -->
        <span
          class="absolute"
          style="left:{slot.x}%; top:{slot.y}%; width:{slot.size}%; height:{slot.size}%; transform:translate(-50%,-50%); z-index:{slot.z};"
        >
          {#if member.id === GROUP_AVATAR_USER_ID}
            <UserAvatar class="size-full" glyphShadowOffset={shadow} />
          {:else}
            <BotAvatar
              botId={member.id}
              name={member.name}
              avatar={member.avatar ?? null}
              class="size-full"
              animated={false}
              glyphShadowOffset={shadow}
            />
          {/if}
        </span>
      {/if}
    {/each}
  </span>
{/if}
