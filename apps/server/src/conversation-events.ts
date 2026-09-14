import { EventEmitter } from "node:events";

export interface ConversationCompletedEvent {
  userId: string;
  conversationId: string;
}

export class ConversationEventBus extends EventEmitter {
  publishCompleted(event: ConversationCompletedEvent) {
    this.emit("completed", event);
  }
}
