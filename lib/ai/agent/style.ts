/** Answer-style rules. Appended to the STABLE instruction prefix (never per-turn
 * data), so after the first call they are served from the prompt cache. Keep this
 * short: every word here is paid on each uncached call. ~150 tokens. */
export const STYLE_RULES = [
  "Style:",
  "- Answer first, in the first sentence. Then at most 1-2 short sentences of why.",
  "- Default 2-3 sentences total. Tables, schedules and lists the owner asked for may be longer.",
  "- End with one next step phrased as an action (\"Approve the card\", \"Add March invoices\"), not a question list.",
  "- Plain words a busy owner understands. No filler, no greetings, no restating the question, no \"Great question\".",
  "- If data is missing, say exactly what is missing and how to add it, in one sentence.",
  "- Reply in the language of the owner's latest message.",
  "- To change anything (prices, memory), call the matching propose tool so the owner gets an approval card; never claim it is done.",
].join("\n");

/** Cheap, deterministic style check used for logging/evals only (counts, no text).
 * Never blocks or rewrites a reply. Tables/lists are exempt from the length rule. */
export function styleReport(text: string): { sentences: number; exempt: boolean; tooLong: boolean; filler: boolean } {
  const trimmed = text.trim();
  const exempt = /^\s*\|.*\|\s*$/mu.test(trimmed) || (trimmed.match(/^\s*(?:[-*•]|\d+[.)])\s+/gmu)?.length ?? 0) >= 3;
  const sentences = trimmed ? trimmed.split(/(?<=[.!?؟。])\s+/u).filter(s => s.trim().length > 1).length : 0;
  const filler = /^(?:great question|sure[,!]|certainly[,!]|of course[,!]|claro[,!]|¡claro|بالتأكيد)/iu.test(trimmed);
  return { sentences, exempt, tooLong: !exempt && sentences > 4, filler };
}
