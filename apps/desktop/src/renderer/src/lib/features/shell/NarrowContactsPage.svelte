<script lang="ts">
  import ContactsSection from '$lib/features/contacts/ContactsSection.svelte';
  import NarrowPage from './NarrowPage.svelte';

  /**
   * 窄屏「通讯录」tab 页（33-narrow-layout）：复用设置弹框「通讯录」分区的
   * 只读 Bot 名册（该分区在窄屏的设置里隐藏，这里是唯一入口）。条目
   *「打开对话」→ chat.openDirect，NarrowShell 的跳转 effect 随之切到对话 tab。
   * 顶部只有红绿灯拖拽带（不渲染标题，见 NarrowPage）。
   */
</script>

<NarrowPage testid="narrow-contacts-page">
  <div class="p-4">
    <ContactsSection />
  </div>
</NarrowPage>
