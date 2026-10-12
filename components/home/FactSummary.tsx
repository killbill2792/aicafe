"use client";

import { formatCents } from "@/lib/calc";
import type { FactBlock } from "./supervisorReplyPresentation";
import { sourceLabel, uniqueSources, type Locale } from "./supervisorReplyPresentation";

export default function FactSummary({blocks,locale,sourceText}:{blocks:FactBlock[];locale:Locale;sourceText:string}){
  if(!blocks.length)return null;
  const many=blocks.length>1;
  return <div className={many?"w-full max-w-[900px] rounded-2xl border border-[#DDE7DC] bg-[#F5F9F5] p-3 sm:p-4":
      "inline-block max-w-full rounded-xl bg-[#F2F8F3] px-4 py-3"}>
    <div data-testid={many?"supervisor-fact-grid":"supervisor-fact-single"}
      className={many?"grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2":"block"}>
      {blocks.map((block,i)=> <div key={i} className="min-w-0">
        <p className="break-words text-[14px] font-semibold leading-snug text-ink-muted">{block.label}</p>
        <p className="mt-1 break-words font-headline text-[24px] font-extrabold leading-tight tracking-tight text-ink">
          {block.type==="metric"?formatCents(block.valueCents):new Intl.NumberFormat(locale).format(block.value)}
        </p>
      </div>)}
    </div>
    <p className="mt-3 border-t border-[#DFE8DC] pt-2 text-[12px] leading-relaxed text-ink-muted">
      {sourceText}: {uniqueSources(blocks).map(s=>sourceLabel(s.source,locale)+" · "+s.asOf).join(" · ")}
    </p>
  </div>;
}
