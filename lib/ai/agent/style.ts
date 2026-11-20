/** Answer-style rules. Appended to the STABLE instruction prefix (never per-turn
 * data), so after the first call they are served from the prompt cache. Keep this
 * short: every word here is paid on each uncached call. ~150 tokens. */
export const STYLE_RULES = [
  "Style:",
  "- Answer first; adapt the depth and organization to the owner’s question.",
  "- Prefer concise, natural replies, not a fixed length. Use Markdown or optional visual groups when helpful. Investigate complex questions across available evidence; explain the conclusion in words even with visuals.",
  "- Offer a relevant next step or follow-up only when useful; do not force one into every reply.",
  "- Plain words a busy owner understands. No filler, no greetings, no restating the question, no \"Great question\".",
  "- If data is missing, distinguish what is known from missing evidence and explain how to resolve the gap.",
  "- Reply in the language of the owner's latest message.",
  "- To change anything (prices, memory), call the matching propose tool so the owner gets an approval card; never claim it is done.",
].join("\n");

/** Cheap, deterministic style check used for logging/evals only (counts, no text).
 * Never blocks or rewrites a reply. Tables/lists are excluded from the historical length diagnostic; it is not an answer limit. */
export function styleReport(text: string): { sentences: number; exempt: boolean; tooLong: boolean; filler: boolean } {
  const trimmed = text.trim();
  const exempt = /^\s*\|.*\|\s*$/mu.test(trimmed) || (trimmed.match(/^\s*(?:[-*•]|\d+[.)])\s+/gmu)?.length ?? 0) >= 3;
  const sentences = trimmed ? trimmed.split(/(?<=[.!?؟。])\s+/u).filter(s => s.trim().length > 1).length : 0;
  const filler = /^(?:great question|sure[,!]|certainly[,!]|of course[,!]|claro[,!]|¡claro|بالتأكيد)/iu.test(trimmed);
  return { sentences, exempt, tooLong: !exempt && sentences > 4, filler };
}
