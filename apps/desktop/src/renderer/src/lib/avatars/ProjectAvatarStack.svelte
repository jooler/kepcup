<script lang="ts">
  import { Users } from '@lucide/svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import * as Avatar from '$lib/components/ui/avatar';
  import BotAvatar from './BotAvatar.svelte';
  import UserAvatar from './UserAvatar.svelte';
  import {
    PROJECT_AVATAR_USER_ID,
    projectAvatarFaces,
    projectAvatarSlots,
    shadowOffsetTowardCenter,
  } from './project-avatar-layout';

  let {
    members,
    class: klass = 'size-10',
    includeUser = true,
  }: {
    members: Array<{ id: string; name: string; avatar?: string | null }>;
    class?: string;
    /** 项目组始终含当前用户；个别场景可关掉。 */
    includeUser?: boolean;
  } = $props();

  const faces = $derived(
    projectAvatarFaces(
      members,
      includeUser
        ? { id: PROJECT_AVATAR_USER_ID, name: settingsStore.userDisplayName, avatar: null as string | null }
        : null,
    ),
  );
  // 与 core 下发的成员预览同一上限（projectAvatarFaces 内封顶）：多了既看不清，也白渲染。
  const seed = $derived(faces.map((member) => member.id).join('|'));
  const slots = $derived(projectAvatarSlots(faces.length, seed));
</script>

{#if faces.length === 0}
  <Avatar.Root class={klass}>
    <Avatar.Fallback
      data-testid="project-avatar-stack"
      class="bg-emerald-600 text-primary-foreground"
    >
      <Users class="size-5" aria-hidden="true" />
    </Avatar.Fallback>
  </Avatar.Root>
{:else}
  <span
    class="relative inline-block shrink-0 {klass}"
    data-testid="project-avatar-stack"
    aria-hidden="true"
  >
    {#each faces as member, index (member.id)}
      {@const slot = slots[index]}
      {#if slot}
        {@const shadow = shadowOffsetTowardCenter(slot)}
        <!-- 不裁切瓦片：字影 drop-shadow / text-shadow 需要略微溢出；圆形由子头像自己裁。 -->
        <span
          class="absolute"
          style="left:{slot.x}%; top:{slot.y}%; width:{slot.size}%; height:{slot.size}%; transform:translate(-50%,-50%); z-index:{slot.z};"
        >
          {#if member.id === PROJECT_AVATAR_USER_ID}
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
