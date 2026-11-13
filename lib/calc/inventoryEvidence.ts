/** A single, bounded display projection for the canonical cv_inventory reader.
 * Neither Supervisor nor Pantry may turn an unverified Toast observation into
 * a current number. This consumes source receipts; it does not fetch or sync POS.
 */
export type InventoryEvidenceState =
  "observed_current"|"not_observed"|"source_failed"|"source_unverified"|"dated_owner_count";
export type InventoryEvidenceRow = {
 source:"toast"|"app";source_ref:string;status:string|null;
 business_date:string|null;menu_item_ref:string|null;stock_status:string|null;
 quantity:number|null;ingredient_id:string|null;source_as_of:string|null;
 checked_at:string|null;reported_stock_status:string|null;
 evidence_state:InventoryEvidenceState;quantity_state:"known"|"unknown";
};
type RawRow=Record<string,unknown>;
const text=(v:unknown):string|null=>typeof v==="string"&&v.length<=256?v:null;
const obj=(v:unknown):RawRow=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as RawRow:{};
const quantity=(v:unknown):number|null=>{
 const n=typeof v==="number"?v:typeof v==="string"&&v.trim()?Number(v):NaN;
 return Number.isFinite(n)&&n>=0?n:null;
};
const validStates=new Set<InventoryEvidenceState>([
 "observed_current","not_observed","source_failed","source_unverified","dated_owner_count"
]);

/** Never infer a missing item from a successful empty Toast response. */
export function projectInventoryEvidence(raw:unknown,maxRows=50):{
 rows:InventoryEvidenceRow[];missing:string[];truncated:boolean
}{
 const input=Array.isArray(raw)?raw:[];
 const rows:InventoryEvidenceRow[]=[];
 const missing=new Set<string>();
 for(const unknownRow of input.slice(0,Math.max(0,Math.min(maxRows,100)))){
  const row=obj(unknownRow),data=obj(row.data);
  const source=row.source==="app"?"app":row.source==="toast"?"toast":null;
  if(!source)continue;
  const declared=text(data.evidence_state);
  const evidence_state:InventoryEvidenceState=source==="app"?"dated_owner_count":
    declared&&validStates.has(declared as InventoryEvidenceState)&&declared!=="dated_owner_count"
      ?declared as InventoryEvidenceState:"source_unverified";
  const number=quantity(row.quantity);
  const verified=source==="app"||evidence_state==="observed_current";
  const reportedStatus=text(data.reported_stock_status)??text(row.stock_status);
  const usable=verified?number:null;
  if(source==="toast"){
   if(evidence_state==="not_observed")missing.add("stockNotObservedInLatestSuccess");
   if(evidence_state==="source_failed")missing.add("stockSourceFailed");
   if(evidence_state==="source_unverified")missing.add("stockFreshnessUnverified");
   if(usable===null)missing.add("stockQuantityUnknown");
  }
  rows.push({
   source,source_ref:text(row.source_ref)??"",status:text(row.status),
   business_date:text(row.business_date),menu_item_ref:text(row.menu_item_ref),
   stock_status:source==="toast"&&verified?text(row.stock_status):null,
   quantity:usable,ingredient_id:source==="app"?text(data.ingredient_id):null,
   source_as_of:source==="toast"?text(data.source_as_of):text(data.count_date),
   checked_at:text(data.checked_at),reported_stock_status:source==="toast"?reportedStatus:null,
   evidence_state,quantity_state:usable===null?"unknown":"known"
  });
 }
 const truncated=input.length>Math.max(0,Math.min(maxRows,100));
 if(truncated)missing.add("inventoryResultTruncated");
 return {rows,missing:[...missing],truncated};
}
