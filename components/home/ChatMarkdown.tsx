import type { ReactNode } from "react";

type Verification = { start: number; end: number };
type SourceLine = { text: string; start: number };
type ListMarker = { ordered: boolean; number: number; content: string; contentStart: number };

function sourceLines(source: string): SourceLine[] {
  let offset = 0;
  return source.split("\n").map(raw => {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const line = { text, start: offset };
    offset += raw.length + 1;
    return line;
  });
}

function listMarker(line: SourceLine): ListMarker | null {
  // Only top-level list markers are supported. Indentation is limited to three
  // spaces to avoid treating indented code as a list.
  const number = /^ {0,3}(\d+)[.)] +(.+)$/.exec(line.text);
  if (number) return {
    ordered: true, number: Number(number[1]), content: number[2],
    contentStart: line.start + number[0].length - number[2].length,
  };
  const bullet = /^ {0,3}[-*+] +(.+)$/.exec(line.text);
  if (bullet) return {
    ordered: false, number: 0, content: bullet[1],
    contentStart: line.start + bullet[0].length - bullet[1].length,
  };
  return null;
}

/** Render verification labels at original UTF-16 offsets, after Markdown
 * delimiters have been interpreted. Both verified and regular text share the
 * same block parser; labels cannot switch lists back to raw source text. */
function annotatedText(
  text: string, absoluteStart: number, spans: readonly Verification[], label: string,
): ReactNode[] {
  const end = absoluteStart + text.length;
  const out: ReactNode[] = [];
  let cursor = absoluteStart;
  for (const span of spans) {
    if (span.end <= cursor || span.start >= end) continue;
    const from = Math.max(cursor, span.start);
    const to = Math.min(end, span.end);
    if (from > cursor) out.push(text.slice(cursor - absoluteStart, from - absoluteStart));
    if (from < to) {
      out.push(<span className="inline" key={from}>
        <span className="underline decoration-dotted">{text.slice(from - absoluteStart, to - absoluteStart)}</span>
        {to === span.end && <span role="note" className="ms-1 rounded-full border border-current px-1 text-xs">{label}</span>}
      </span>);
    }
    cursor = Math.max(cursor, to);
  }
  if (cursor < end) out.push(text.slice(cursor - absoluteStart));
  return out;
}

function inlineMarkdown(
  text: string, absoluteStart: number, spans: readonly Verification[], label: string,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  // No model-authored HTML or links: React escapes literal source text. Inline
  // code is rendered as text and is never reparsed as emphasis.
  const pattern = /(\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|`([^`\n]+)`)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) {
      nodes.push(...annotatedText(text.slice(cursor, match.index), absoluteStart + cursor, spans, label));
    }
    const delimiter = match[2] !== undefined || match[3] !== undefined ? 2 : 1;
    const content = match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6];
    const inner = annotatedText(content, absoluteStart + match.index + delimiter, spans, label);
    const key = absoluteStart + match.index;
    nodes.push(match[2] !== undefined || match[3] !== undefined
      ? <strong key={key} className="font-bold">{inner}</strong>
      : match[6] !== undefined
        ? <code key={key} className="rounded bg-surface2 px-1">{inner}</code>
        : <em key={key}>{inner}</em>);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) nodes.push(...annotatedText(text.slice(cursor), absoluteStart + cursor, spans, label));
  return nodes;
}

export function ChatMarkdown({ text, unverified = [], label }: {
  text: string; unverified?: readonly Verification[]; label: string;
}) {
  const spans = [...unverified].filter(s =>
    Number.isSafeInteger(s.start) && Number.isSafeInteger(s.end) &&
    s.start >= 0 && s.end > s.start && s.end <= text.length,
  ).sort((a,b) => a.start - b.start)
    .filter((s, i, all) => i === 0 || s.start >= all[i - 1].end);

  const lines = sourceLines(text);
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].text.trim()) { index++; continue; }
    const first = listMarker(lines[index]);
    if (first) {
      const ordered = first.ordered;
      const firstNumber = first.number;
      const entries: ReactNode[] = [];
      const listStart = index;
      while (index < lines.length) {
        const marker = listMarker(lines[index]);
        if (!marker || marker.ordered !== ordered) {
          // Markdown allows blank lines between list items. Only consume them
          // if the next nonblank line is another marker of this list type.
          if (!lines[index].text.trim()) {
            let lookahead = index;
            while (lookahead < lines.length && !lines[lookahead].text.trim()) lookahead++;
            const next = lookahead < lines.length ? listMarker(lines[lookahead]) : null;
            if (next && next.ordered === ordered) { index = lookahead; continue; }
          }
          break;
        }
        const item = inlineMarkdown(marker.content, marker.contentStart, spans, label);
        entries.push(ordered
          ? <li key={index} value={marker.number} className="ps-1">{item}</li>
          : <li key={index} className="ps-1">{item}</li>);
        index++;
      }
      blocks.push(ordered
        ? <ol key={listStart} start={firstNumber} className="list-decimal space-y-1 ps-6">{entries}</ol>
        : <ul key={listStart} className="list-disc space-y-1 ps-6">{entries}</ul>);
      continue;
    }
    const start = index;
    const rows: ReactNode[] = [];
    while (index < lines.length && lines[index].text.trim() && !listMarker(lines[index])) {
      if (rows.length) rows.push("\n");
      const line = lines[index];
      rows.push(...inlineMarkdown(line.text, line.start, spans, label));
      index++;
    }
    if (index === start) index++;
    else blocks.push(<p key={start} className="whitespace-pre-line">{rows}</p>);
  }
  return <div className="space-y-2 break-words text-[17px] leading-relaxed text-ink">{blocks}</div>;
}
