import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ConversationMessage, ConversationPage, ConversationScope, ConversationThread,
} from "./contracts";
import { PAGE_SIZE, THREAD_PAGE_SIZE } from "./contracts";
import type { ConversationRepository } from "./service";

type ThreadRow = {
  id: string; title: string | null; created_at: string; updated_at: string;
  last_message_at: string | null;
};
type MessageRow = {
  id: string; thread_id: string; role: "owner" | "supervisor";
  content_type: "text" | "blocks"; text_content: string | null;
  structured_content: unknown[] | null; grounding: Record<string, unknown> | null;
  client_message_id: string | null; created_at: string;
};

const THREAD_COLUMNS = "id, title, created_at, updated_at, last_message_at";
const MESSAGE_COLUMNS = "id, thread_id, role, content_type, text_content, structured_content, grounding, client_message_id, created_at";

function thread(row: ThreadRow): ConversationThread {
  return {
    id: row.id, title: row.title, createdAt: row.created_at,
    updatedAt: row.updated_at, lastMessageAt: row.last_message_at,
  };
}

function message(row: MessageRow): ConversationMessage {
  return {
    id: row.id, threadId: row.thread_id, role: row.role,
    contentType: row.content_type, text: row.text_content,
    blocks: row.structured_content, grounding: row.grounding,
    clientMessageId: row.client_message_id, createdAt: row.created_at,
  };
}

/** No service-role client, no raw SQL, and no assistant-message insertion path. */
export class SupabaseConversationRepository implements ConversationRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findThread(scope: ConversationScope, threadId: string) {
    const { data, error } = await this.client.from("ai_threads")
      .select(THREAD_COLUMNS)
      .eq("id", threadId).eq("business_id", scope.businessId)
      .eq("owner_user_id", scope.ownerUserId).maybeSingle();
    if (error) throw error;
    return data ? thread(data as ThreadRow) : null;
  }

  async findThreadByRequest(scope: ConversationScope, requestId: string) {
    const { data, error } = await this.client.from("ai_threads")
      .select(THREAD_COLUMNS)
      .eq("client_request_id", requestId).eq("business_id", scope.businessId)
      .eq("owner_user_id", scope.ownerUserId).maybeSingle();
    if (error) throw error;
    return data ? thread(data as ThreadRow) : null;
  }

  async insertThread(scope: ConversationScope, requestId: string, title: string | null) {
    const { data, error } = await this.client.from("ai_threads")
      .insert({
        business_id: scope.businessId,
        owner_user_id: scope.ownerUserId,
        client_request_id: requestId,
        title,
      }).select(THREAD_COLUMNS).single();
    if (error) throw error;
    return thread(data as ThreadRow);
  }

  async listThreads(scope: ConversationScope, offset: number): Promise<ConversationPage<ConversationThread>> {
    const { data, error } = await this.client.from("ai_threads")
      .select(THREAD_COLUMNS)
      .eq("business_id", scope.businessId).eq("owner_user_id", scope.ownerUserId)
      .order("updated_at", { ascending: false }).order("id", { ascending: false })
      .range(offset, offset + THREAD_PAGE_SIZE);
    if (error) throw error;
    const rows = data as ThreadRow[];
    const hasMore = rows.length > THREAD_PAGE_SIZE;
    return {
      items: rows.slice(0, THREAD_PAGE_SIZE).map(thread),
      nextOffset: hasMore ? offset + THREAD_PAGE_SIZE : null,
    };
  }

  async findMessageByKey(scope: ConversationScope, threadId: string, key: string) {
    const { data, error } = await this.client.from("ai_messages")
      .select(MESSAGE_COLUMNS)
      .eq("business_id", scope.businessId).eq("owner_user_id", scope.ownerUserId)
      .eq("thread_id", threadId).eq("client_message_id", key).maybeSingle();
    if (error) throw error;
    return data ? message(data as MessageRow) : null;
  }

  async insertOwnerMessage(scope: ConversationScope, threadId: string, key: string, text: string) {
    const { data, error } = await this.client.from("ai_messages")
      .insert({
        business_id: scope.businessId, owner_user_id: scope.ownerUserId,
        thread_id: threadId, author_user_id: scope.ownerUserId,
        role: "owner", content_type: "text", text_content: text,
        structured_content: null, grounding: null, client_message_id: key,
      }).select(MESSAGE_COLUMNS).single();
    if (error) throw error;
    return message(data as MessageRow);
  }

  async listMessages(scope: ConversationScope, threadId: string, offset: number):
    Promise<ConversationPage<ConversationMessage>> {
    const { data, error } = await this.client.from("ai_messages")
      .select(MESSAGE_COLUMNS)
      .eq("business_id", scope.businessId).eq("owner_user_id", scope.ownerUserId)
      .eq("thread_id", threadId)
      .order("created_at", { ascending: false }).order("id", { ascending: false })
      .range(offset, offset + PAGE_SIZE);
    if (error) throw error;
    const rows = data as MessageRow[];
    const hasMore = rows.length > PAGE_SIZE;
    // Return chronological page, with older pages accessible via nextOffset.
    return {
      items: rows.slice(0, PAGE_SIZE).reverse().map(message),
      nextOffset: hasMore ? offset + PAGE_SIZE : null,
    };
  }
}
