import { IncomingMessage } from "../types/domain.js";

export function conversationKeyFor(message: IncomingMessage): string {
  if (message.chatType === "p2p") {
    return `p2p:${message.chatId}`;
  }
  if (message.threadId) {
    return `group:${message.chatId}:thread:${message.threadId}`;
  }
  return `chat:${message.chatId}`;
}
