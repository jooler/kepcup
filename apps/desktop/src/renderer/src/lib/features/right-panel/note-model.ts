/** 右栏「便签」tab 的本地条目：id 在新建时即生成（note_），落库前 persisted=false。 */
export interface NoteItem {
  id: string;
  /** 所属对话（换对话时在途的新建仍落在原对话名下）。 */
  conversationId: string;
  text: string;
  persisted: boolean;
  createdAt: number;
  updatedAt: number;
}
