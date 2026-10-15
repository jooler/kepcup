<script lang="ts">
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import GroupAvatarStack from '$lib/avatars/GroupAvatarStack.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';

  /** 工作台里的成员头像：Bot 用 Bot 头像，群用成员头像堆叠（查不到成员时是默认群图标）。 */
  let {
    kind,
    id,
    name,
    class: klass = 'size-6',
  }: { kind: 'bot' | 'group'; id: string; name: string; class?: string } = $props();

  const bot = $derived(
    kind === 'bot' ? (contacts.bots.find((item) => item.id === id) ?? null) : null,
  );
  const previews = $derived(
    kind === 'group'
      ? (chat.conversations.find((conversation) => conversation.id === id)?.memberPreviews ?? [])
      : [],
  );
</script>

{#if kind === 'group'}
  <GroupAvatarStack members={previews} class={klass} />
{:else}
  <BotAvatar
    botId={id}
    {name}
    avatar={bot?.avatar ?? null}
    class={klass}
    fallbackClass="text-xs"
    animated={false}
  />
{/if}
