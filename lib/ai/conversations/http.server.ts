import { NextResponse } from "next/server";
import { z } from "zod";
import { ConversationApiError } from "./auth.server";
import { ConversationConflict, ConversationNotFound } from "./service";

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };

export function conversationJson(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: NO_STORE });
}

/** Cookie-authenticated POSTs must be same-origin. Do not permit missing origins. */
export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new ConversationApiError(403, "invalid_origin");
  }
}

export async function readBoundedJson(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new ConversationApiError(415, "json_required");

  const reader = request.body?.getReader();
  if (!reader) throw new ConversationApiError(400, "invalid_json");
  const bytes: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 8192) {
        await reader.cancel();
        throw new ConversationApiError(413, "body_too_large");
      }
      bytes.push(value);
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const data = new Uint8Array(total);
    let offset = 0;
    for (const part of bytes) { data.set(part, offset); offset += part.byteLength; }
    return JSON.parse(decoder.decode(data));
  } catch (error) {
    if (error instanceof ConversationApiError) throw error;
    throw new ConversationApiError(400, "invalid_json");
  } finally {
    reader.releaseLock();
  }
}

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ConversationApiError(422, "invalid_input");
  return result.data;
}

export function conversationError(error: unknown) {
  if (error instanceof ConversationApiError) {
    return conversationJson({ error: error.code }, error.status);
  }
  if (error instanceof ConversationNotFound) {
    return conversationJson({ error: "conversation_not_found" }, 404);
  }
  if (error instanceof ConversationConflict) {
    return conversationJson({ error: "idempotency_conflict" }, 409);
  }
  const dbCode = error !== null && typeof error === "object" && "code" in error
    ? String(error.code) : "";
  if (dbCode === "42P01" || dbCode === "PGRST205") {
    return conversationJson({ error: "conversation_storage_unavailable" }, 503);
  }
  // Do not log raw prompts, tokens, record data, SQL, or provider errors.
  return conversationJson({ error: "conversation_request_failed" }, 500);
}
