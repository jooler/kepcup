<script lang="ts">
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { clientIdentity } from './client-identity';
  import { clientNameDialog } from './client-name-dialog.svelte';
  import { CLIENT_NAME_MAX_CHARS } from './client-name.svelte';
  import { presence } from './presence.svelte';

  /** 本机设备名（D121 P3）：只存本机，改名后立即重报在线状态。 */
  let name = $state('');
  let wasOpen = false;

  $effect(() => {
    if (clientNameDialog.open && !wasOpen) name = clientIdentity.name;
    wasOpen = clientNameDialog.open;
  });

  function save(): void {
    clientIdentity.setName(name);
    presence.refresh();
    clientNameDialog.close();
    toast.success(t('collab.clientNameSaved'));
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    }
  }
</script>

<Dialog.Root
  open={clientNameDialog.open}
  onOpenChange={(open) => {
    if (!open) clientNameDialog.close();
  }}
>
  <Dialog.Content class="sm:max-w-sm" data-testid="client-name-dialog">
    <Dialog.Header>
      <Dialog.Title>{t('collab.clientNameTitle')}</Dialog.Title>
      <Dialog.Description>{t('collab.clientNameHint')}</Dialog.Description>
    </Dialog.Header>
    <Input
      bind:value={name}
      maxlength={CLIENT_NAME_MAX_CHARS}
      placeholder={t('collab.clientNamePlaceholder')}
      onkeydown={onKeydown}
      data-testid="client-name-input"
    />
    <Dialog.Footer>
      <Button variant="outline" onclick={() => clientNameDialog.close()}>
        {t('collab.clientNameCancel')}
      </Button>
      <Button disabled={name.trim().length === 0} onclick={save} data-testid="client-name-save">
        {t('collab.clientNameSave')}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
