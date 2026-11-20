"use client";

import { formatCafeCurrency } from "@/lib/format/cafeCurrency";
import en from "@/messages/en.json";
import type { FactBlock } from "./supervisorReplyPresentation";
import { sourceLabel, uniqueSources, type Locale } from "./supervisorReplyPresentation";

function factValueText(block:FactBlock,locale:Locale,cafeCurrency:string|null):string{
  if(block.type==="metric")return formatCafeCurrency(block.valueCents,locale,cafeCurrency).text;
  if(block.type==="percent")return new Intl.NumberFormat(locale,{style:"percent",maximumFractionDigits:1}).format(block.valueBps/10000);
  return new Intl.NumberFormat(locale).format(block.value);
}
/** The sign of an amount does not establish whether it is good for the café. */
export default function FactSummary({blocks,locale,sourceText,cafeCurrency=null}:{blocks:FactBlock[];locale:Locale;sourceText:string;cafeCurrency?:string|null}){
  if(!blocks.length)return null;
  const many=blocks.length>1;
  // Transparent background by design: the box exists to emphasize a verified
  // number inside the surrounding answer, not to look like a separate card.
  return <div className={many?"w-full max-w-[900px] bg-transparent py-3":
      "inline-block max-w-full bg-transparent py-3"}>
    <div data-testid={many?"supervisor-fact-grid":"supervisor-fact-single"}
      className={many?"grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2":"block"}>
      {blocks.map((block,i)=> <div key={i} className="min-w-0">
        <p className="break-words text-[14px] font-semibold leading-snug text-ink-muted">{block.label}</p>
        <p className="mt-1 break-words font-headline text-[28px] font-medium leading-tight tracking-tight tabular-nums text-ink">
          {factValueText(block,locale,cafeCurrency)}
        </p>

      </div>)}
    </div>
    {blocks.some(block=>block.type==="metric"&&formatCafeCurrency(block.valueCents,locale,cafeCurrency).currencyMissing)&&<p className="text-[17px] text-ink-muted">{en.SupervisorExperience.currencyUnavailable}</p>}
    <p className="mt-3 border-t border-line pt-2 text-[13px] leading-relaxed text-ink-muted">
      {sourceText}: {uniqueSources(blocks).map(s=>sourceLabel(s.source,locale)+" · "+s.asOf).join(" · ")}
    </p>
  </div>;
}
