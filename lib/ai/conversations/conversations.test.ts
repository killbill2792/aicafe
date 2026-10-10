import { describe, expect, it, vi } from "vitest";
import { addOwnerMessageInput, createThreadInput } from "./contracts";
import { assessGrounding } from "./grounding";
import {
  ConversationConflict, ConversationNotFound, ConversationService,
  type ConversationRepository,
} from "./service";
import type { ConversationMessage, ConversationScope, ConversationThread } from "./contracts";

const a = { businessId: "cafe-a", ownerUserId: "owner-a" };
const b = { businessId: "cafe-b", ownerUserId: "owner-b" };
const thread: ConversationThread = {
  id: "thread-id", title: "Daily overview",
  createdAt: "2026-10-10T05:00:00Z", updatedAt: "2026-10-10T05:00:00Z",
  lastMessageAt: null,
};
const ownerMessage: ConversationMessage = {
  id: "msg-id", threadId: thread.id, role: "owner", contentType: "text",
  text: "How are we doing?", blocks: null, grounding: null,
  createdAt: "2026-10-10T05:01:00Z", clientMessageId: "key1",
};

function repository(): ConversationRepository {
  return {
    findThread: vi.fn(async () => thread),
    findThreadByRequest: vi.fn(async () => null),
    insertThread: vi.fn(async () => thread),
    listThreads: vi.fn(async () => ({ items: [thread], nextOffset: null })),
    findMessageByKey: vi.fn(async () => null),
    insertOwnerMessage: vi.fn(async () => ownerMessage),
    listMessages: vi.fn(async () => ({ items: [ownerMessage], nextOffset: null })),
  };
}

describe("Supervisor Phase 3 conversation foundation", () => {
  it("requires a scoped owner and café before any read/write", () => {
    const repo = repository();
    expect(() => new ConversationService(repo, { ...a, ownerUserId: "" })).toThrow();
    expect(() => new ConversationService(repo, { ...a, businessId: "" })).toThrow();
  });

  it("never takes businessId, role or owner identity from posted data", async () => {
    const repo = repository();
    const service = new ConversationService(repo, a);
    await service.createThread("retry1", "Daily overview");
    await service.addOwnerMessage(thread.id, "key1", ownerMessage.text!);
    expect(repo.insertThread).toHaveBeenCalledWith(a, "retry1", "Daily overview");
    expect(repo.insertOwnerMessage).toHaveBeenCalledWith(a, thread.id, "key1", ownerMessage.text);
    expect(createThreadInput.safeParse({ requestId: crypto.randomUUID(), businessId: b.businessId }).success).toBe(false);
    expect(addOwnerMessageInput.safeParse({ clientMessageId: crypto.randomUUID(), text: "hello", role: "supervisor" }).success).toBe(false);
    expect(addOwnerMessageInput.safeParse({ clientMessageId: crypto.randomUUID(), text: "hello", grounding: { status: "verified" } }).success).toBe(false);
  });

  it("rejects empty, oversized, invalid and unexpected message input", () => {
    const key = crypto.randomUUID();
    expect(addOwnerMessageInput.safeParse({ clientMessageId: key, text: " " }).success).toBe(false);
    expect(addOwnerMessageInput.safeParse({ clientMessageId: key, text: "x".repeat(4001) }).success).toBe(false);
    expect(addOwnerMessageInput.safeParse({ clientMessageId: "not-uuid", text: "Hello" }).success).toBe(false);
    expect(addOwnerMessageInput.parse({ clientMessageId: key, text: "  Hello  " }).text).toBe("Hello");
    expect(createThreadInput.safeParse({ requestId: key, title: "x".repeat(121) }).success).toBe(false);
  });

  it("returns the existing thread for an identical retry without another insert", async () => {
    const repo = repository();
    repo.findThreadByRequest = vi.fn(async () => thread);
    const result = await new ConversationService(repo, a).createThread("retry", thread.title);
    expect(result).toEqual(thread);
    expect(repo.insertThread).not.toHaveBeenCalled();
  });

  it("rejects a reused thread request ID with changed content", async () => {
    const repo = repository();
    repo.findThreadByRequest = vi.fn(async () => thread);
    await expect(new ConversationService(repo, a).createThread("retry", "different"))
      .rejects.toBeInstanceOf(ConversationConflict);
  });

  it("recovers an identical thread after a concurrent unique-key race", async () => {
    const repo = repository();
    let count = 0;
    repo.findThreadByRequest = vi.fn(async () => (++count > 1 ? thread : null));
    repo.insertThread = vi.fn(async () => { throw { code: "23505" }; });
    expect(await new ConversationService(repo, a).createThread("retry", thread.title)).toEqual(thread);
  });

  it("does not retry unrelated database failures", async () => {
    const repo = repository();
    repo.insertThread = vi.fn(async () => { throw { code: "42501" }; });
    await expect(new ConversationService(repo, a).createThread("retry", thread.title))
      .rejects.toEqual({ code: "42501" });
  });

  it("refuses messages on a thread not visible to this owner", async () => {
    const repo = repository();
    repo.findThread = vi.fn(async () => null);
    await expect(new ConversationService(repo, b).addOwnerMessage("thread-id", "key", "secret"))
      .rejects.toBeInstanceOf(ConversationNotFound);
    expect(repo.insertOwnerMessage).not.toHaveBeenCalled();
  });

  it("reuses the exact persisted owner message for idempotent replays", async () => {
    const repo = repository();
    repo.findMessageByKey = vi.fn(async () => ownerMessage);
    const service = new ConversationService(repo, a);
    expect(await service.addOwnerMessage(thread.id, "key1", ownerMessage.text!)).toEqual(ownerMessage);
    expect(repo.insertOwnerMessage).not.toHaveBeenCalled();
    await expect(service.addOwnerMessage(thread.id, "key1", "different"))
      .rejects.toBeInstanceOf(ConversationConflict);
  });

  it("recovers a concurrent duplicate owner message without changing history", async () => {
    const repo = repository();
    let calls = 0;
    repo.findMessageByKey = vi.fn(async () => (++calls > 1 ? ownerMessage : null));
    repo.insertOwnerMessage = vi.fn(async () => { throw { code: "23505" }; });
    const service = new ConversationService(repo, a);
    expect(await service.addOwnerMessage(thread.id, "key1", ownerMessage.text!)).toEqual(ownerMessage);
  });

  it("rejects replaying a client key against a Supervisor-authored result", async () => {
    const repo = repository();
    repo.findMessageByKey = vi.fn(async () => ({ ...ownerMessage, role: "supervisor" as const, contentType: "blocks" as const }));
    await expect(new ConversationService(repo, a).addOwnerMessage(thread.id, "key1", ownerMessage.text!))
      .rejects.toBeInstanceOf(ConversationConflict);
  });

  it("paginates threads without making another business available", async () => {
    const repo = repository();
    const result = await new ConversationService(repo, a).listThreads(20);
    expect(result.items).toEqual([thread]);
    expect(repo.listThreads).toHaveBeenCalledWith(a, 20);
  });

  it("keeps message history scoped and requires access before querying", async () => {
    const repo = repository();
    const svc = new ConversationService(repo, a);
    expect((await svc.listMessages(thread.id, 50)).items).toEqual([ownerMessage]);
    expect(repo.listMessages).toHaveBeenCalledWith(a, thread.id, 50);
    repo.findThread = vi.fn(async () => null);
    await expect(svc.listMessages(thread.id, 0)).rejects.toBeInstanceOf(ConversationNotFound);
  });

  it("fails closed on missing tool data even if an evidence source is supplied", () => {
    expect(assessGrounding("profitability", null, [{ source: "cafe_state", identifier: "profit", asOf: "2026-10-10" }]).status)
      .toBe("insufficient_evidence");
  });

  it("requires verifiable source references even when data is available", () => {
    const slice = { available: true as const, value: { ownerProfitCents: 58048 }, quality: { level: "high" as const, missingInputs: [], estimatedInputs: [], staleInputs: [] } };
    expect(assessGrounding("profitability", slice, []).status).toBe("insufficient_evidence");
    expect(assessGrounding("profitability", slice, [{ source: "cafe_state", identifier: "snapshot", asOf: "2026-10-10" }]).status).toBe("verified");
  });

  it("never treats stale source inputs as verified grounding", () => {
    const slice = {
      available: true as const, value: { profitCents: 5000 },
      quality: { level: "high" as const, missingInputs: [], estimatedInputs: [], staleInputs: ["salesSync"] },
    };
    const result = assessGrounding("profitability", slice, [
      { source: "cafe_state", identifier: "month-profit", asOf: "2026-10-10" },
    ]);
    expect(result.status).toBe("insufficient_evidence");
    expect(result.missingInputs).toContain("stale:salesSync");
  });

  it("preserves estimated versus missing distinctions and never upgrades missing to verified", () => {
    const evidence = [{ source: "pricing_engine" as const, identifier: "latte", asOf: "2026-10-10" }];
    const estimated = { available: true as const, value: { suggestedPriceCents: 600 }, quality: { level: "medium" as const, missingInputs: [], estimatedInputs: ["benchmark"], staleInputs: [] } };
    expect(assessGrounding("menu_pricing", estimated, evidence).status).toBe("estimated");
    expect(assessGrounding("menu_pricing", { ...estimated, quality: { ...estimated.quality, missingInputs: ["recipe"] } }, evidence).status).toBe("insufficient_evidence");
  });
});
