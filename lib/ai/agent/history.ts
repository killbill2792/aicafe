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
