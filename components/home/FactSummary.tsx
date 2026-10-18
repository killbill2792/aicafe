"use client";

import { formatCents } from "@/lib/calc";
import type { FactBlock } from "./supervisorReplyPresentation";
import { sourceLabel, uniqueSources, type Locale } from "./supervisorReplyPresentation";

function factValueText(block:FactBlock,locale:Locale):string{
  if(block.type==="metric")return formatCents(block.valueCents);
  if(block.type==="percent")return new Intl.NumberFormat(locale,{style:"percent",maximumFractionDigits:1}).format(block.valueBps/10000);
  return new Intl.NumberFormat(locale).format(block.value);
}
export default function FactSummary({blocks,locale,sourceText}:{blocks:FactBlock[];locale:Locale;sourceText:string}){
  if(!blocks.length)return null;
  const many=blocks.length>1;
  // Transparent background by design: the box exists to emphasize a verified
  // number inside the surrounding answer, not to look like a separate card.
  return <div className={many?"w-full max-w-[900px] rounded-2xl border border-[#DDE7DC] bg-transparent p-3 sm:p-4":
      "inline-block max-w-full rounded-xl border border-[#DDE7DC] bg-transparent px-4 py-3"}>
    <div data-testid={many?"supervisor-fact-grid":"supervisor-fact-single"}
      className={many?"grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2":"block"}>
      {blocks.map((block,i)=> <div key={i} className="min-w-0">
        <p className="break-words text-[14px] font-semibold leading-snug text-ink-muted">{block.label}</p>
        <p className="mt-1 break-words font-headline text-[24px] font-extrabold leading-tight tracking-tight text-good">
          {factValueText(block,locale)}
        </p>
        {block.type==="percent" && <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[#E4EDE2]" role="presentation">
          <div className="h-full rounded-full bg-good transition-[width]"
            style={{width:Math.max(0,Math.min(100,block.valueBps/100))+"%"}} />
        </div>}
      </div>)}
    </div>
    <p className="mt-3 border-t border-[#DFE8DC] pt-2 text-[12px] leading-relaxed text-ink-muted">
      {sourceText}: {uniqueSources(blocks).map(s=>sourceLabel(s.source,locale)+" · "+s.asOf).join(" · ")}
    </p>
  </div>;
}
