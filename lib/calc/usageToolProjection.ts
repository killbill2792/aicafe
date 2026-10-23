import type { UsageRow } from "./usageVariance";

export type UsageToolRead={from:string;to:string;rows:UsageRow[];missing:string[];groupBy:string|null};
type ToolRow=Omit<UsageRow,"groups"> & {groups:UsageRow["groups"];groupsComplete:boolean};
/** The group identity must be stable across changes in order or number of groups.
 * Old ordinal IDs are invalidated by usageEvidenceRefresh during the next
 * authoritative read. A short deterministic fingerprint keeps model payloads
 * bounded even for a shift spanning many employee IDs. */
export function usageGroupEvidenceId(ingredientId:string,groupBy:string|null,key:string):string{
 let hash=2166136261;
 for(let i=0;i<key.length;i++){
  hash=Math.imul(hash^key.charCodeAt(i),16777619)>>>0;
 }
 return ingredientId+":group:"+(groupBy??"all")+":"+hash.toString(16).padStart(8,"0");
}
type VerifiedQuantity={
 id:string;metric:"expected"|"actual"|"expected_group";quantity:number|null;unit:UsageRow["unit"];
 ingredient?:string;differencePercent?:number|null;
};
/** Read-only, bounded tool projection. The evidence checker's existing typed
 * 'items[id].quantity' and 'differencePercent' recognition verifies model prose
 * without changing checkNumbers or accepting arbitrary numeric fields. */
export function projectUsageTool(read:UsageToolRead,maxChars=3400) {
 const rows:ToolRow[]=[],items:VerifiedQuantity[]=[];
 const result={
  source:"usage_variance",period:{from:read.from,to:read.to},agentId:"maya" as const,
  missing:read.missing.slice(0,12),groupBy:read.groupBy,rows,items,
  actualShiftUsage:null as null,omittedIngredients:read.rows.length,
  omittedGroups:read.rows.reduce((n,r)=>n+r.groups.length,0),
  truncated:false,
  note:"Grouped figures are expected only; actual stock use is available only for the full count period."
 };
 const fits=()=>JSON.stringify(result).length<=maxChars;
 for(const row of read.rows){
  const summary:ToolRow={ingredientId:row.ingredientId,name:row.name,unit:row.unit,
   expected:row.expected,actual:row.actual,differencePct:row.differencePct,
   status:row.status,missing:row.missing.slice(0,5),groups:[],groupsComplete:row.groups.length===0};
  const evidence:VerifiedQuantity[]=[
   {id:row.ingredientId+":expected",metric:"expected",ingredient:row.name,unit:row.unit,
    quantity:row.expected,differencePercent:row.differencePct},
   {id:row.ingredientId+":actual",metric:"actual",unit:row.unit,quantity:row.actual},
  ];
  rows.push(summary);items.push(...evidence);result.omittedIngredients--;
  if(!fits()){
   rows.pop();items.splice(-evidence.length);result.omittedIngredients++;break;
  }
 }
 // Round-robin prevents a single heavily staffed ingredient from monopolizing
 // the entire 1.5k-token budget and hiding other ingredients.
 for(let index=0;;index++){
  let seen=false;
  for(const [rowIndex,summary] of rows.entries()){
   const group=read.rows[rowIndex].groups[index];
   if(!group)continue;
   seen=true;
   const projected={key:group.key.slice(0,80),label:group.label.slice(0,80),
    staff:[] as string[],expected:group.expected,actual:null as null,expectedOnly:true as const};
   const evidence:VerifiedQuantity={id:usageGroupEvidenceId(summary.ingredientId,read.groupBy,group.key),
    metric:"expected_group",unit:summary.unit,quantity:group.expected};
   summary.groups.push(projected);items.push(evidence);result.omittedGroups--;
   if(!fits()){summary.groups.pop();items.pop();result.omittedGroups++;}
  }
  if(!seen)break;
 }
 rows.forEach((row,index)=>{
  row.groupsComplete=row.groups.length===read.rows[index].groups.length;
 });
 result.truncated=result.omittedIngredients>0||result.omittedGroups>0||
  read.missing.length>result.missing.length;
 if(result.truncated&&!result.missing.includes("usageResultTruncated")){
  result.missing.push("usageResultTruncated");
  while(!fits()&&items.length>0){
   const last=items.at(-1)!;
   if(last.metric==="expected_group"){
    const parent=rows.find(r=>r.ingredientId===last.id.split(":group:")[0]);
    parent?.groups.pop();result.omittedGroups++;
    items.pop();
   }else{
    const removed=rows.pop();
    if(!removed)break;
    items.splice(-2);result.omittedIngredients++;
   }
  }
 }
 rows.forEach((row,index)=>{
  row.groupsComplete=row.groups.length===read.rows[index].groups.length;
 });
 return result;
}
