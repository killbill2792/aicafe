export class AgentReplyTooLongError extends Error { constructor() { super("agent_reply_too_long"); } }
type Span = { start: number; end: number };
// Protect recorded claims and even *verified* currency tokens from block boundaries.
const moneyToken = /(?:(?:[$€£]|USD|EUR|GBP|ر\.س|د\.إ|دولار)\s*)?[-+−]?[٠-٩۰-۹\d]+(?:[.,٬٫\u00a0\u202f][٠-٩۰-۹\d]+)*(?:[ \u00a0\u202f]*(?:[$€£]|USD|EUR|GBP|ر\.س|د\.إ|دولار|[%٪]))?/gu;

/** Preserve every character, preferring paragraphs, lines then whitespace. */
export function splitAgentText(text: string, unverified: readonly Span[] = [],maxBlocks=Infinity) {
  const value = text || " ";
  const protectedSpans: Span[] = [...unverified];
  for (const match of value.matchAll(moneyToken))
    protectedSpans.push({ start: match.index, end: match.index + match[0].length });
  const safe = (at: number) => !protectedSpans.some(span => span.start < at && at < span.end);
  const blocks: Array<{ type: "text"; text: string }> = [];
  let start = 0;
  while (start < value.length) {
    if (blocks.length >= maxBlocks) throw new AgentReplyTooLongError();
    const limit = Math.min(start + 1200, value.length);
    let end = limit;
    if (limit < value.length) {
      const choices: number[][] = [[], [], []];
      for (let i = start + 1; i < limit; i++) {
        if (!safe(i + 1)) continue;
        if (value[i] === "\n" && value[i - 1] === "\n") choices[0].push(i + 1);
        else if (value[i] === "\n") choices[1].push(i + 1);
        else if (/\s/u.test(value[i])) choices[2].push(i + 1);
      }
      // Prefer a natural boundary only if the remainder can fit in the real reply contract.
      const minEnd=Math.max(start+1,value.length-(maxBlocks-blocks.length-1)*1200);
      const fitting=choices.map(items=>items.filter(at=>at>=minEnd));
      const preferred = fitting.find(items => items.length);
      if (preferred) end = preferred[preferred.length - 1];
      else if (!safe(end)) {
        // A >1200-character token may be hard-split, but never through a
        // currency/number claim, even when the adjacent word is oversized.
        while (end > start && !safe(end)) end--;
        if (end === start) end=limit;
      }
    }
    blocks.push({ type: "text", text: value.slice(start, end) });
    start = end;
  }
  return blocks;
}
