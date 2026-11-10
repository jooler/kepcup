class ClientNameDialogState {
  open = $state(false);

  openDialog(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
  }
}

export const clientNameDialog = new ClientNameDialogState();
