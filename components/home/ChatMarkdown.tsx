import type { ReactNode } from "react";

/** Deliberately limited, escaped Markdown: no raw HTML or clickable model-authored links. */
function inlineMarkdown(text: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`)/g;
  let start = 0, match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > start) nodes.push(text.slice(start, match.index));
    const name = key + ":" + match.index;
    if (match[2]) nodes.push(<strong key={name} className="font-bold">{match[2]}</strong>);
    else if (match[3]) nodes.push(<em key={name}>{match[3]}</em>);
    else nodes.push(<code key={name} className="rounded bg-surface2 px-1">{match[4]}</code>);
    start = match.index + match[0].length;
  }
  if (start < text.length) nodes.push(text.slice(start));
  return nodes;
}

export function ChatMarkdown({ text, unverified = [], label }: {
  text: string; unverified?: readonly { start: number; end: number }[]; label: string;
}) {
  // Keep the original UTF-16 source offsets for verification annotations.
  const valid = [...unverified].sort((a,b) => a.start-b.start)
    .filter(s => Number.isSafeInteger(s.start) && Number.isSafeInteger(s.end) &&
      s.start >= 0 && s.end > s.start && s.end <= text.length);
  const annotated: ReactNode[] = [];
  let offset = 0;
  for (const span of valid) {
    if (span.start < offset) continue;
    if (span.start > offset) annotated.push(...inlineMarkdown(text.slice(offset,span.start),String(offset)));
    annotated.push(<span key={"verify:"+span.start} className="inline"><span className="underline decoration-dotted">{text.slice(span.start,span.end)}</span><span role="note" className="ms-1 rounded-full border border-current px-1 text-xs">{label}</span></span>);
    offset = span.end;
  }
  if (valid.length) {
    annotated.push(...inlineMarkdown(text.slice(offset),"tail"));
    return <div className="whitespace-pre-wrap break-words text-[17px] leading-relaxed text-ink">{annotated}</div>;
  }

  const lines = text.split("\n");
  const result: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) { index++; continue; }
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(lines[index]);
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(lines[index]);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const entries: ReactNode[] = [];
      while (index < lines.length) {
        const m = ordered ? /^\s*\d+[.)]\s+(.+)$/.exec(lines[index]) : /^\s*[-*+]\s+(.+)$/.exec(lines[index]);
        if (!m) break;
        entries.push(<li key={index} className="ps-1">{inlineMarkdown(m[1],String(index))}</li>);
        index++;
      }
      result.push(ordered
        ? <ol key={index} className="list-decimal space-y-1 ps-6">{entries}</ol>
        : <ul key={index} className="list-disc space-y-1 ps-6">{entries}</ul>);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() &&
      !/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(lines[index])) paragraph.push(lines[index++]);
    if (paragraph.length) result.push(<p key={index} className="whitespace-pre-line">{inlineMarkdown(paragraph.join("\n"),String(index))}</p>);
    else index++;
  }
  return <div className="space-y-2 break-words text-[17px] leading-relaxed text-ink">{result}</div>;
}
