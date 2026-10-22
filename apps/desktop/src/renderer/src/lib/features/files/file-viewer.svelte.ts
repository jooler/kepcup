import type { MessageArtifact } from '@kepcup/shared';

/**
 * Global state of the file artifact overlay (Bot file cards). One file at a
 * time; the conversation id scopes the `files.preview` read.
 */
export interface OpenFileArtifact {
  artifact: MessageArtifact;
  conversationId: string;
}

class FileViewerState {
  current: OpenFileArtifact | null = $state(null);

  get open(): boolean {
    return this.current !== null;
  }

  show(artifact: MessageArtifact, conversationId: string): void {
    this.current = { artifact, conversationId };
  }

  close(): void {
    this.current = null;
  }
}

export const fileViewer = new FileViewerState();
