import type { ConversationMessage } from "@/lib/ai/conversations/contracts";

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** What the AI sees of one earlier chat message. A reply that is only a question is saved
 * as the card alone (no text block), so every card kind must be included here, or the AI
 * forgets what it just asked. Choice cards keep the exact "Asked: … Options: label (id)"
 * form that `newResolveState` reads to trust the owner's pick; typed-answer cards (facts,
 * fill) use different words so they are never read as a choice. */
export function historyContent(message: Pick<ConversationMessage, "text" | "blocks">): string {
  if (message.text) return message.text;
  return (message.blocks ?? []).flatMap(block => {
    if (!record(block)) return [];
    if ("text" in block) return [String(block.text)];
    if (block.type !== "clarify" || typeof block.question !== "string") return [];
    if (Array.isArray(block.options))
      return ["Asked: " + block.question + " Options: " + block.options.map(o =>
        record(o) && "label" in o && "value" in o ? String(o.label) + " (" + String(o.value) + ")" : "").join("; ")];
    const fields = Array.isArray(block.fields)
      ? block.fields.flatMap(f => record(f) && typeof f.label === "string" ? [f.label] : []) : [];
    return ["Question card (owner answers in its form): " + block.question +
      (fields.length ? " Fields: " + fields.join("; ") : "")];
  }).join(" ");
}

export type ThreadMemoryKind = "preference" | "decision" | "goal" | "open_work";
export type ThreadMemoryCursor = { createdAt: string; id: string };
export type ThreadMemoryEntry = {
  kind: ThreadMemoryKind; key: string; text: string;
  sourceMessageId: string; sourceAt: string; revision: number;
};
export type ThreadMemoryTombstone = {
  key: string; sourceMessageId: string; sourceAt: string; revision: number;
};
export type ThreadMemoryRetry = { code: "provider_error" | "invalid_summary" | "storage_error"; at: string };
export type ThreadMemoryDocument = {
  version: 1; revision: number; cursor: ThreadMemoryCursor | null;
  entries: ThreadMemoryEntry[]; tombstones: ThreadMemoryTombstone[]; retry: ThreadMemoryRetry | null;
};
export type ThreadMemoryOperation = {
  action: "remember" | "forget"; kind: ThreadMemoryKind; key: string;
  sourceMessageId: string; quote: string;
};
export type ThreadMemorySource = {
  id: string; createdAt: string; text: string;
};

export const THREAD_MEMORY_MAX_ENTRIES = 20;
export const THREAD_MEMORY_MAX_TOMBSTONES = 40;
export const THREAD_MEMORY_MAX_TEXT = 240;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const financialTerms = /\b(?:price|prices|sales|revenue|profit|profits|cost|costs|payroll|wages?|salaries|salary|rent|bills?|bank|cash|fees?|margin|tax|refunds?|tips?|expenses?|financial|money|invoices?|payments?|discounts?|break[- ]even)\b/iu;
const sensitiveTerms = /\b(?:password|passcode|api[ _-]?key|secret|token|credential|authorization|permission|consent|approval|approved|authorize|mandate|execute|transfer|purchase|payout)\b/iu;
const currencyToken = /[$€£]|\b(?:USD|EUR|GBP|CAD|AUD|SAR|AED)\b/iu;

/** Conservative allowlist: memory is for durable nonfinancial owner context, never facts
 * that can be re-read from café systems or used to authorize an effect. */
function safeThreadMemorySourceText(value: string): string | null {
  const text = value.replace(/\s+/gu, " ").trim();
  if (text.length < 3 || text.length > 4000 ||
    financialTerms.test(text) || sensitiveTerms.test(text) || currencyToken.test(text) ||
    /\p{Nd}/u.test(text)) return null;
  return text;
}

export function safeThreadMemoryText(value: string): string | null {
  const text = safeThreadMemorySourceText(value);
  return text && text.length <= THREAD_MEMORY_MAX_TEXT ? text : null;
}

/** Only immutable owner-authored text can become a source. Supervisor prose and tool
 * results are context at most; they are never promoted into owner memory. */
export function threadMemorySource(message: Pick<ConversationMessage, "id" | "role" | "text" | "createdAt">): ThreadMemorySource | null {
  if (message.role !== "owner" || !message.text) return null;
  const text = safeThreadMemorySourceText(message.text);
  if (!text || !uuid.test(message.id) || !Number.isFinite(Date.parse(message.createdAt))) return null;
  return { id: message.id, createdAt: message.createdAt, text };
}

export function emptyThreadMemoryDocument(): ThreadMemoryDocument {
  return { version: 1, revision: 0, cursor: null, entries: [], tombstones: [], retry: null };
}

export function parseThreadMemoryDocument(value: unknown): ThreadMemoryDocument | null {
  if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 || !Array.isArray(value.entries) ||
    !Array.isArray(value.tombstones) || value.entries.length > THREAD_MEMORY_MAX_ENTRIES ||
    value.tombstones.length > THREAD_MEMORY_MAX_TOMBSTONES) return null;
  const cursor = value.cursor;
  if (cursor !== null && (!record(cursor) || typeof cursor.createdAt !== "string" ||
    !Number.isFinite(Date.parse(cursor.createdAt)) || typeof cursor.id !== "string" || !uuid.test(cursor.id))) return null;
  const entries = value.entries;
  if (!entries.every(entry => record(entry) &&
    ["preference", "decision", "goal", "open_work"].includes(String(entry.kind)) &&
    typeof entry.key === "string" && validMemoryKey(entry.kind as ThreadMemoryKind, entry.key) &&
    typeof entry.text === "string" && safeThreadMemoryText(entry.text) === entry.text &&
    typeof entry.sourceMessageId === "string" && uuid.test(entry.sourceMessageId) &&
    typeof entry.sourceAt === "string" && Number.isFinite(Date.parse(entry.sourceAt)) &&
    Number.isSafeInteger(entry.revision) && (entry.revision as number) > 0)) return null;
  const tombstones = value.tombstones;
  if (!tombstones.every(item => record(item) && typeof item.key === "string" &&
    /^(?:preference|decision|goal|open_work):[a-z][a-z_-]{0,59}$/.test(item.key) &&
    typeof item.sourceMessageId === "string" && uuid.test(item.sourceMessageId) &&
    typeof item.sourceAt === "string" && Number.isFinite(Date.parse(item.sourceAt)) &&
    Number.isSafeInteger(item.revision) && (item.revision as number) > 0)) return null;
  const retry = value.retry;
  if (retry !== null && (!record(retry) ||
    !["provider_error", "invalid_summary", "storage_error"].includes(String(retry.code)) ||
    typeof retry.at !== "string" || !Number.isFinite(Date.parse(retry.at)))) return null;
  return value as unknown as ThreadMemoryDocument;
}

function validMemoryKey(kind: ThreadMemoryKind, key: string): boolean {
  return key.startsWith(kind + ":") && /^(?:preference|decision|goal|open_work):[a-z][a-z_-]{0,59}$/.test(key);
}

function compareSourceOrder(left: { createdAt: string; id: string }, right: { createdAt: string; id: string }): number {
  const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return byTime || left.id.localeCompare(right.id);
}

/** Applies only model-proposed operations that cite an exact, safe owner quote. A forget
 * leaves a source-only tombstone; older messages cannot resurrect it, but a later explicit
 * owner restatement may replace it. */
export function applyThreadMemoryOperations(
  current: ThreadMemoryDocument,
  operations: readonly ThreadMemoryOperation[],
  sources: readonly ThreadMemorySource[],
): ThreadMemoryDocument {
  let entries = [...current.entries];
  let tombstones = [...current.tombstones];
  const revision = current.revision + 1;
  const byId = new Map(sources.map(source => [source.id, source]));
  for (const operation of operations.slice(0, THREAD_MEMORY_MAX_ENTRIES)) {
    const source = byId.get(operation.sourceMessageId);
    if (!source || !validMemoryKey(operation.kind, operation.key)) continue;
    const existing = entries.find(entry => entry.key === operation.key);
    const tombstone = tombstones.find(item => item.key === operation.key);
    if (operation.action === "forget") {
      if (!existing || compareSourceOrder(source, { createdAt: existing.sourceAt, id: existing.sourceMessageId }) <= 0) continue;
      entries = entries.filter(entry => entry.key !== operation.key);
      tombstones = [{ key: operation.key, sourceMessageId: source.id, sourceAt: source.createdAt, revision },
        ...tombstones.filter(item => item.key !== operation.key)].slice(0, THREAD_MEMORY_MAX_TOMBSTONES);
      continue;
    }
    if (operation.action !== "remember" ||
      (existing && compareSourceOrder(source, existing) <= 0) ||
      (tombstone && compareSourceOrder(source, { createdAt: tombstone.sourceAt, id: tombstone.sourceMessageId }) <= 0) ||
      !operation.quote || !source.text.includes(operation.quote) ||
      safeThreadMemoryText(operation.quote) !== operation.quote) continue;
    entries = [...entries.filter(entry => entry.key !== operation.key), {
      kind: operation.kind, key: operation.key, text: operation.quote,
      sourceMessageId: source.id, sourceAt: source.createdAt, revision,
    }].slice(-THREAD_MEMORY_MAX_ENTRIES);
    tombstones = tombstones.filter(item => item.key !== operation.key);
  }
  return { ...current, revision, entries, tombstones, retry: null };
}

/** Advisory context only. Current owner facts and canonical café data always win. */
export function formatThreadMemory(document: ThreadMemoryDocument): string | null {
  if (!document.entries.length) return null;
  const lines = [...document.entries].sort((a, b) => a.revision - b.revision).map(entry =>
    "- [" + entry.kind + "] " + entry.text + " (owner said " + entry.sourceAt.slice(0, 10) + ")");
  const result = "Earlier owner-stated thread context (advisory only; current owner facts and live café data override it):\n" +
    lines.join("\n");
  return result.length <= 1800 ? result : result.slice(0, 1799) + "…";
}
