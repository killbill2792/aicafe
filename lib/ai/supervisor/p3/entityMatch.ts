/** Exact Unicode word-boundary matching of owner-named records, not substrings.
 * When multiple catalog names overlap, select the longest exact mention.
 * Duplicate identical names remain ambiguous without a separately grounded ID.
 */
const normalized=(v:string)=>v.normalize("NFKC").toLocaleLowerCase()
  .replace(/\s+/gu," ").trim();
const escaped=(v:string)=>v.replace(/[.*+?^${}()|[\]\\]/gu,"\\$&");
const spans=(goal:string,name:string,allowPlural=false):Array<{start:number;end:number}>=>{
  if(!name)return [];
  const pattern=new RegExp("(?<![\\p{L}\\p{N}])"+escaped(name)+
    (allowPlural?"(?:s|es)?":"")+
    "(?![\\p{L}\\p{N}])","gu");
  return [...goal.matchAll(pattern)].map(m=>({
    start:m.index,end:m.index+m[0].length,
  }));
};
export function isWholeNamedEntity(goal:string,name:string,
  candidates:readonly {id:string;name:string}[],allowPlural=false):boolean{
  const subject=normalized(goal),label=normalized(name);
  const exact=spans(subject,label,allowPlural);
  if(!exact.length)return false;
  if(candidates.filter(x=>normalized(x.name)===label)
    .some((x,i,arr)=>arr.some(y=>y.id!==x.id)))return false;
  return exact.some(match=>!candidates.some(other=>{
    const longer=normalized(other.name);
    return longer.length>label.length &&
      spans(subject,longer,allowPlural).some(hit=>
        hit.start<=match.start&&hit.end>=match.end);
  }));
}
