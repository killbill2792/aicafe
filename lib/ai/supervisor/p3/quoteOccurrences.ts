import { normalizeScenarioNumber } from "@/lib/calc/scenarioExpression";

/** Rebase the model's zero-based quote occurrence in the WHOLE owner utterance
 * to the exact audited clauses covered by one simulation. Never borrow a
 * repeated number belonging to an unrelated semantic clause.
 */
const normalize=(s:string)=>normalizeScenarioNumber(
  s.normalize("NFKC").toLocaleLowerCase());
const adjacent=/[\p{L}\p{N}.,\u066B\u066C]/u;
function wholeMatches(text:string,quoted:string):Array<{start:number;end:number}>{
  if(!/^-?\d+(?:\.\d{1,2})?$/u.test(quoted))return [];
  const found:Array<{start:number;end:number}>=[];
  for(let at=text.indexOf(quoted);at>=0;at=text.indexOf(quoted,at+1)){
    const before=text[at-1]??"",after=text[at+quoted.length]??"";
    if(before&&adjacent.test(before)||after&&adjacent.test(after)||
      before==="-"&&!quoted.startsWith("-"))continue;
    found.push({start:at,end:at+quoted.length});
  }
  return found;
}
export function rebaseQuotedOccurrence(input:{
  goal:string;allClauses:readonly string[];coveredClauses:readonly string[];
  quotedNumber:string;occurrence:number;
}):number|null {
  if(!Number.isSafeInteger(input.occurrence)||input.occurrence<0||
    input.occurrence>30)return null;
  const original=normalize(input.goal),quoted=normalize(input.quotedNumber);
  if(!quoted)return null;
  const ranges=new Map<string,{start:number;end:number}>();
  let cursor=0;
  for(const clause of input.allClauses){
    const part=normalize(clause);
    const start=original.indexOf(part,cursor);
    if(!part||start<0||ranges.has(clause))return null;
    ranges.set(clause,{start,end:start+part.length});
    cursor=start+part.length;
  }
  const matches=wholeMatches(original,quoted);
  const selected=matches[input.occurrence];
  if(!selected)return null;
  const allowed=input.coveredClauses.map(clause=>ranges.get(clause));
  if(allowed.some(range=>!range))return null;
  const inside=(hit:{start:number;end:number})=>
    allowed.some(range=>range&&hit.start>=range.start&&hit.end<=range.end);
  if(!inside(selected))return null;
  return matches.filter(inside).findIndex(hit=>
    hit.start===selected.start&&hit.end===selected.end);
}
