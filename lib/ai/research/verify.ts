import type {UnverifiedNumber} from "@/lib/ai/agent/checkNumbers";

/** Numbers in prose or data: 1,234.50 / 12.5 / 800. A colon next to it means a clock time, a dash a date. */
const NUMBER=/(?<![\w.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(%?)/gu;

type Found={text:string;start:number;end:number;value:number;decimals:number;percent:boolean};

function numbersIn(text:string,skipTimesAndDates:boolean):Found[]{
  const found:Found[]=[];
  for(const m of text.matchAll(NUMBER)){
    const start=m.index??0,end=start+m[0].length;
    const before=text[start-1]??"",after=text[end]??"";
    // Times (13:00), dates (2026-11-25) and ranges are not figures to verify.
    if(skipTimesAndDates&&(before===":"||after===":"||before==="-"||(after==="-"&&/\d/u.test(text[end+1]??""))))continue;
    const value=Number(m[1].replace(/,/gu,"")+(m[2]?"."+m[2]:""));
    if(Number.isFinite(value))found.push({text:m[0],start,end,value,decimals:m[2]?.length??0,percent:m[3]==="%"});
  }
  return found;
}

/** Every value the owner could be shown legitimately: what was retrieved or calculated this turn, what the owner
 * wrote, and the café context, each also as cents→currency and ratio→percent. */
function allowedValues(sources:readonly string[]):number[]{
  const out=new Set<number>();
  for(const source of sources)for(const n of numbersIn(source,false)){
    for(const v of [n.value,n.value/100,n.value*100,n.value/1000,n.value/1_000_000])out.add(v);
  }
  return [...out];
}

/** Numbers in a research answer that appear nowhere in the evidence. Small counts and years are not flagged. */
export function unsupportedNumbers(answer:string,evidence:readonly string[]):UnverifiedNumber[]{
  const allowed=allowedValues(evidence);
  const flagged:UnverifiedNumber[]=[];
  for(const n of numbersIn(answer,true)){
    if(n.value<=10&&n.decimals===0&&!n.percent)continue;
    if(n.decimals===0&&n.value>=1990&&n.value<=2100)continue;
    const tolerance=0.5*Math.pow(10,-n.decimals)+1e-9;
    // "$1.2 million" style roundings: allow rounding to the displayed precision only.
    if(allowed.some(a=>Math.abs(a-n.value)<=tolerance))continue;
    flagged.push({text:n.text,start:n.start,end:n.end,kind:n.percent?"percent":"number"});
  }
  return flagged;
}
