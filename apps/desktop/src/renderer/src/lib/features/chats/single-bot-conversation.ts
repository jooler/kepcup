/**
 * A conversation with one bot and no project routing: a direct chat, or a
 * card chat with its executor. Project chats are not single-bot.
 */
export function isSingleBotConversation(type: string): boolean {
  return type === 'direct' || type === 'card';
}
