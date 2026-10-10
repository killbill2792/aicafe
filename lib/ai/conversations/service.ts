import type {
  ConversationMessage, ConversationPage, ConversationScope, ConversationThread,
} from "./contracts";
import { PAGE_SIZE, THREAD_PAGE_SIZE } from "./contracts";

export class ConversationNotFound extends Error {}
export class ConversationConflict extends Error {}

export interface ConversationRepository {
  findThread(scope: ConversationScope, threadId: string): Promise<ConversationThread | null>;
  findThreadByRequest(scope: ConversationScope, requestId: string): Promise<ConversationThread | null>;
  insertThread(scope: ConversationScope, requestId: string, title: string | null): Promise<ConversationThread>;
  listThreads(scope: ConversationScope): Promise<ConversationThread[]>;
  findMessageByKey(scope: ConversationScope, threadId: string, key: string): Promise<ConversationMessage | null>;
  insertOwnerMessage(scope: ConversationScope, threadId: string, key: string, text: string): Promise<ConversationMessage>;
  listMessages(scope: ConversationScope, threadId: string, offset: number): Promise<ConversationPage<ConversationMessage>>;
}

/** Server-side application boundary. Identity is from authenticated session,
 * never accepted from a conversation request or an AI-generated tool argument.
 */
export class ConversationService {
  constructor(private repository: ConversationRepository, private scope: ConversationScope) {
    if (!scope.businessId || !scope.ownerUserId) throw new Error("Missing authorized conversation identity");
  }

  async createThread(requestId: string, title: string | null = null): Promise<ConversationThread> {
    const existing = await this.repository.findThreadByRequest(this.scope, requestId);
    if (existing) {
      if (existing.title !== title) throw new ConversationConflict("Thread request key reused with different content");
      return existing;
    }
    try {
      return await this.repository.insertThread(this.scope, requestId, title);
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const retried = await this.repository.findThreadByRequest(this.scope, requestId);
      if (!retried) throw error;
      if (retried.title !== title) throw new ConversationConflict("Thread request key reused with different content");
      return retried;
    }
  }

  listThreads(): Promise<ConversationThread[]> {
    return this.repository.listThreads(this.scope);
  }

  async getThread(threadId: string): Promise<ConversationThread> {
    const thread = await this.repository.findThread(this.scope, threadId);
    if (!thread) throw new ConversationNotFound("Conversation not found");
    return thread;
  }

  async addOwnerMessage(
    threadId: string,
    clientMessageId: string,
    text: string,
  ): Promise<ConversationMessage> {
    await this.getThread(threadId);
    const existing = await this.repository.findMessageByKey(this.scope, threadId, clientMessageId);
    if (existing) return assertSameOwnerText(existing, text);
    try {
      return await this.repository.insertOwnerMessage(this.scope, threadId, clientMessageId, text);
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const retried = await this.repository.findMessageByKey(this.scope, threadId, clientMessageId);
      if (!retried) throw error;
      return assertSameOwnerText(retried, text);
    }
  }

  async listMessages(threadId: string, offset: number): Promise<ConversationPage<ConversationMessage>> {
    await this.getThread(threadId);
    return this.repository.listMessages(this.scope, threadId, offset);
  }
}

function assertSameOwnerText(message: ConversationMessage, expectedText: string): ConversationMessage {
  if (message.role !== "owner" || message.contentType !== "text" || message.text !== expectedText) {
    throw new ConversationConflict("Message key reused with different content");
  }
  return message;
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export { PAGE_SIZE, THREAD_PAGE_SIZE };
