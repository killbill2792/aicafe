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
    if (block.type === "owner_question" && record(block.title) && record(block.input)) {
      const question = typeof block.title.en === "string" ? block.title.en :
        typeof block.title.es === "string" ? block.title.es :
          typeof block.title.ar === "string" ? block.title.ar : "";
      if (!question) return [];
      const options = Array.isArray(block.input.options) ? block.input.options.flatMap(option =>
        record(option) && record(option.label)
          ? [typeof option.label.en === "string" ? option.label.en :
            typeof option.label.es === "string" ? option.label.es :
              typeof option.label.ar === "string" ? option.label.ar : ""]
          : []).filter(Boolean) : [];
      const hint = record(block.input.hint)
        ? (typeof block.input.hint.en === "string" ? block.input.hint.en :
          typeof block.input.hint.es === "string" ? block.input.hint.es :
            typeof block.input.hint.ar === "string" ? block.input.hint.ar : "")
        : "";
      return ["Owner question: " + question +
        (options.length ? " Options: " + options.join("; ") : "") +
        (hint ? " Hint: " + hint : "")];
    }
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
  id: string; createdAt: string; text: string; structuredText?: string;
};

export const THREAD_MEMORY_MAX_ENTRIES = 20;
export const THREAD_MEMORY_MAX_TOMBSTONES = 40;
export const THREAD_MEMORY_MAX_TEXT = 240;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isoTimestamp = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$/;
const validTimestamp = (value: unknown): value is string =>
  typeof value === "string" && isoTimestamp.test(value) && Number.isFinite(Date.parse(value));
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const financialTerms = /\b(?:price|prices|pricing|sales|revenue|income|profit|profits|cost|costs|payroll|wages?|salaries|salary|rent|bills?|bank|cash|fees?|margin|tax|refunds?|tips?|expenses?|financial|money|invoices?|payments?|discounts?|break[- ]even|budget|balance|transaction|metrics?|kpis?|unit sales)\b/iu;
const sensitiveTerms = /\b(?:password|passcode|api[ _-]?key|secret|token|credential|authorization|permission|consent|approval|approved|authorize|mandate|execute|transfer|purchase|payout)\b/iu;
const currencyToken = /[$€£¥₹₽₩₺₫₪₦₱]|\b(?:USD|EUR|GBP|CAD|AUD|SAR|AED|INR|JPY|CNY|RMB|CHF|SEK|NOK|DKK|BHD|KWD|QAR|OMR|PKR|NZD|SGD|HKD)\b/iu;

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
export function threadMemorySource(
  message: Pick<ConversationMessage, "id" | "role" | "text" | "createdAt">,
  structuredResponseText?: string,
): ThreadMemorySource | null {
  if (message.role !== "owner" || !message.text) return null;
  const text = safeThreadMemorySourceText(message.text);
  if (!text || !uuid.test(message.id) || !Number.isFinite(Date.parse(message.createdAt))) return null;
  const structuredText = structuredResponseText ? safeThreadMemorySourceText(structuredResponseText) : null;
  return { id: message.id, createdAt: message.createdAt, text, ...(structuredText ? { structuredText } : {}) };
}

export function emptyThreadMemoryDocument(): ThreadMemoryDocument {
  return { version: 1, revision: 0, cursor: null, entries: [], tombstones: [], retry: null };
}

export function parseThreadMemoryDocument(value: unknown): ThreadMemoryDocument | null {
  if (!record(value) || !exactKeys(value, ["version", "revision", "cursor", "entries", "tombstones", "retry"]) ||
    value.version !== 1 || !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 || (value.revision as number) > 999_999_999 ||
    !Array.isArray(value.entries) || !Array.isArray(value.tombstones) ||
    value.entries.length > THREAD_MEMORY_MAX_ENTRIES ||
    value.tombstones.length > THREAD_MEMORY_MAX_TOMBSTONES) return null;

  const cursor = value.cursor;
  if (cursor !== null && (!record(cursor) || !exactKeys(cursor, ["createdAt", "id"]) ||
    !validTimestamp(cursor.createdAt) || typeof cursor.id !== "string" || !uuid.test(cursor.id))) return null;
  if (cursor === null && (value.entries.length > 0 || value.tombstones.length > 0)) return null;

  const entries = value.entries;
  if (!entries.every(entry => record(entry) &&
    exactKeys(entry, ["kind", "key", "text", "sourceMessageId", "sourceAt", "revision"]) &&
    ["preference", "decision", "goal", "open_work"].includes(String(entry.kind)) &&
    typeof entry.key === "string" && validMemoryKey(entry.kind as ThreadMemoryKind, entry.key) &&
    typeof entry.text === "string" && safeThreadMemoryText(entry.text) === entry.text &&
    typeof entry.sourceMessageId === "string" && uuid.test(entry.sourceMessageId) &&
    validTimestamp(entry.sourceAt) &&
    Number.isSafeInteger(entry.revision) && (entry.revision as number) > 0 &&
    (entry.revision as number) <= (value.revision as number) &&
    cursor !== null && compareSourceOrder(
      { createdAt: entry.sourceAt, id: entry.sourceMessageId },
      cursor as ThreadMemoryCursor,
    ) <= 0)) return null;

  const tombstones = value.tombstones;
  if (!tombstones.every(item => record(item) &&
    exactKeys(item, ["key", "sourceMessageId", "sourceAt", "revision"]) &&
    typeof item.key === "string" &&
    /^(?:preference|decision|goal|open_work):[a-z][a-z_-]{0,59}$/.test(item.key) &&
    typeof item.sourceMessageId === "string" && uuid.test(item.sourceMessageId) &&
    validTimestamp(item.sourceAt) &&
    Number.isSafeInteger(item.revision) && (item.revision as number) > 0 &&
    (item.revision as number) <= (value.revision as number) &&
    cursor !== null && compareSourceOrder(
      { createdAt: item.sourceAt, id: item.sourceMessageId },
      cursor as ThreadMemoryCursor,
    ) <= 0)) return null;

  const entryKeys = entries.map(entry => (entry as ThreadMemoryEntry).key);
  const tombstoneKeys = tombstones.map(item => (item as ThreadMemoryTombstone).key);
  if (new Set(entryKeys).size !== entryKeys.length ||
    new Set(tombstoneKeys).size !== tombstoneKeys.length ||
    entryKeys.some(key => tombstoneKeys.includes(key))) return null;

  const retry = value.retry;
  if (retry !== null && (!record(retry) || !exactKeys(retry, ["code", "at"]) ||
    !["provider_error", "invalid_summary", "storage_error"].includes(String(retry.code)) ||
    !validTimestamp(retry.at))) return null;
  return value as unknown as ThreadMemoryDocument;
}

function validMemoryKey(kind: ThreadMemoryKind, key: string): boolean {
  return key.startsWith(kind + ":") && /^(?:preference|decision|goal|open_work):[a-z][a-z_-]{0,59}$/.test(key);
}

function compareSourceOrder(left: { createdAt: string; id: string }, right: { createdAt: string; id: string }): number {
  const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (byTime) return byTime;
  const leftId = left.id.toLowerCase();
  const rightId = right.id.toLowerCase();
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
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
    if (!source || !uuid.test(source.id) || !validTimestamp(source.createdAt) ||
      safeThreadMemorySourceText(source.text) !== source.text ||
      (source.structuredText !== undefined && safeThreadMemorySourceText(source.structuredText) !== source.structuredText) ||
      !validMemoryKey(operation.kind, operation.key)) continue;
    const existing = entries.find(entry => entry.key === operation.key);
    const tombstone = tombstones.find(item => item.key === operation.key);
    if (operation.action === "forget") {
      if (!existing || operation.quote !== "" ||
        compareSourceOrder(source, { createdAt: existing.sourceAt, id: existing.sourceMessageId }) <= 0) continue;
      entries = entries.filter(entry => entry.key !== operation.key);
      tombstones = [{ key: operation.key, sourceMessageId: source.id, sourceAt: source.createdAt, revision },
        ...tombstones.filter(item => item.key !== operation.key)].slice(0, THREAD_MEMORY_MAX_TOMBSTONES);
      continue;
    }
    if (operation.action !== "remember" ||
      (existing && compareSourceOrder(source, { createdAt: existing.sourceAt, id: existing.sourceMessageId }) <= 0) ||
      (tombstone && compareSourceOrder(source, { createdAt: tombstone.sourceAt, id: tombstone.sourceMessageId }) <= 0) ||
      !operation.quote || (!source.text.includes(operation.quote) && !source.structuredText?.includes(operation.quote)) ||
      safeThreadMemoryText(operation.quote) !== operation.quote) continue;
    const nextEntries = [...entries.filter(entry => entry.key !== operation.key), {
      kind: operation.kind, key: operation.key, text: operation.quote,
      sourceMessageId: source.id, sourceAt: source.createdAt, revision,
    }];
    if (nextEntries.length > THREAD_MEMORY_MAX_ENTRIES) {
      const evicted = nextEntries.shift()!;
      tombstones = [{
        key: evicted.key, sourceMessageId: source.id, sourceAt: source.createdAt, revision,
      }, ...tombstones.filter(item => item.key !== operation.key && item.key !== evicted.key)]
        .slice(0, THREAD_MEMORY_MAX_TOMBSTONES);
    }
    entries = nextEntries;
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
