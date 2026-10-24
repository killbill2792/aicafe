/** Tool-only name resolution. Never let model-provided ids choose between matching records. */
export type ChoiceCandidate = { id: string; label: string; detail: string };
export type EntityResolution<T> =
  | { status: "resolved"; value: T }
  | { status: "ambiguous"; candidates: ChoiceCandidate[] }
  | { status: "none"; suggestions: ChoiceCandidate[] };
export const normalizedName = (value: string): string => value.normalize("NFKD")
  .replace(/[\u064b-\u065f\u0670\u0640]/gu, "")
  .replace(/[أإآٱ]/gu, "ا").replace(/ى/gu, "ي").replace(/ؤ/gu, "و")
  .replace(/ئ/gu, "ي").replace(/ة/gu, "ه")
  .replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("und")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
const score = (query: string, label: string): number => {
  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  if (label.includes(query)) return 2;
  if (query.split(" ").some(token => token.length > 1 && label.includes(token))) return 3;
  return 10;
};
export function resolveEntity<T>(
  _kind: string, query: string, rows: readonly T[],
  field: { nameOf: (row: T) => string; idOf: (row: T) => string; describe: (row: T) => string },
): EntityResolution<T> {
  const q = normalizedName(query);
  const choices = (items: readonly T[]): ChoiceCandidate[] => {
    const names = new Map<string,number>();
    for (const item of items) {
      const name = normalizedName(field.nameOf(item));
      names.set(name,(names.get(name)??0)+1);
    }
    return items.slice(0,4).map(item => {
      const name = field.nameOf(item), detail = field.describe(item);
      const duplicate = (names.get(normalizedName(name))??0)>1;
      return { id: field.idOf(item), label: duplicate ? name + " — " + detail : name, detail };
    });
  };
  if (!q) return {status:"none", suggestions:choices(rows)};
  const ids = rows.filter(row => field.idOf(row).toLowerCase() === query.toLowerCase());
  if (ids.length === 1) return {status:"resolved",value:ids[0]};
  const exact = rows.filter(row => normalizedName(field.nameOf(row))===q);
  if (exact.length===1)return {status:"resolved",value:exact[0]};
  if (exact.length>1)return {status:"ambiguous",candidates:choices(exact)};
  const matches = rows.filter(row => {
    const name=normalizedName(field.nameOf(row));
    return name.includes(q) || q.includes(name) && name.length >= 3;
  });
  if(matches.length===1)return {status:"resolved",value:matches[0]};
  if(matches.length>1)return {status:"ambiguous",candidates:choices(matches)};
  return {status:"none",suggestions:choices([...rows].sort((a,b)=>
    score(q,normalizedName(field.nameOf(a)))-score(q,normalizedName(field.nameOf(b)))))};
}
export type ResolveState = {
  ownerText: string;
  priorChoice: string | null;
  seenIds: Set<string>;
  ambiguous: ChoiceCandidate[][];
  asked: boolean;
};
export function newResolveState(ownerText: string, history: readonly {role:string;content:string}[] = []): ResolveState {
  const last=history.at(-1);
  const previous=history.at(-2);
  return {ownerText,priorChoice:last?.role==="assistant"&&last.content.includes("Asked:")?ownerText:
    previous?.role==="assistant"&&previous.content.includes("Asked:")?ownerText:null,
    seenIds:new Set(),ambiguous:[],asked:false};
}
export function choicePayload(result: EntityResolution<unknown>, source: string, period: {from:string;to:string}|null) {
  return result.status==="ambiguous"
    ? {source,period,missing:[],needsOwnerChoice:true,candidates:result.candidates}
    : {source,period,missing:["notFound"],suggestions:result.suggestions};
}
/** Reject a proposal when a result named several targets and the owner did not identify one. */
export function ownerChoiceGuard(state: ResolveState|undefined, targetId:string) {
  if(!state)return null;
  const owner = normalizedName(state.ownerText);
  for(const candidates of state.ambiguous) {
    if(!candidates.some(candidate=>candidate.id===targetId))continue;
    if(candidates.some(candidate=>candidate.id===targetId&&(
      normalizedName(candidate.label)===owner ||
      normalizedName(candidate.label).length>0&&owner.includes(normalizedName(candidate.label))
    )))return null;
    return {missing:["ownerChoiceRequired"],needsOwnerChoice:true,candidates};
  }
  return null;
}
export function observeToolResult(state:ResolveState|undefined,result:Record<string,unknown>):void{
  if(!state||!Array.isArray(result.missing)||result.missing.length)return;
  if(result.needsOwnerChoice===true&&Array.isArray(result.candidates)) {
    const candidates=result.candidates.filter((v):v is ChoiceCandidate=>
      Boolean(v)&&typeof v==="object"&&typeof v.id==="string"&&typeof v.label==="string"&&typeof v.detail==="string").slice(0,4);
    if(candidates.length>1)state.ambiguous.push(candidates);
  }
  const visit=(value:unknown,depth:number)=>{
    if(depth>5||!value||typeof value!=="object")return;
    if(Array.isArray(value)){for(const item of value.slice(0,50))visit(item,depth+1);return;}
    for(const [key,v] of Object.entries(value)){
      if((key==="id"||key==="itemId"||key==="employeeId"||key==="productId"||key==="product_id")&&
        typeof v==="string"&&/^[a-f0-9]{8}-[a-f0-9-]{27,}$/iu.test(v))state.seenIds.add(v.toLowerCase());
      else visit(v,depth+1);
    }
  };
  visit(result,0);
}
