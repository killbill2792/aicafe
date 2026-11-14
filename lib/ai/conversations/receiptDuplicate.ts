/** Receipt photos can differ in bytes while showing the same printed sale.
 * Treat matching merchant/date/total as a POSSIBLE duplicate, not proof.
 * A legitimate repeat purchase is still allowed after owner review. */
export type ReceiptProposalHint={
 status:string;created_at:string;canonical_effect_payload:unknown;
};
type Summary={groupId:string;vendor:string|null;totalCents:number|null;dates:readonly string[];ownerMessageAt:string};
export function possiblePriorReceipt(rows:readonly ReceiptProposalHint[],current:Summary):boolean{
 if(!current.vendor?.trim()||current.totalCents===null||!current.dates.length)return false;
 const normalized=(v:string)=>v.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/gu," ");
 return rows.some(row=>{
  if(!["approved","executing","committed","monitored","manual_pending"].includes(row.status)||
    !Number.isFinite(Date.parse(row.created_at))||
    Date.parse(row.created_at)>=Date.parse(current.ownerMessageAt))return false;
  const e=row.canonical_effect_payload;
  if(!e||typeof e!=="object")return false;
  const record=e as Record<string,unknown>;
  return typeof record.receiptGroupId==="string"&&record.receiptGroupId!==current.groupId&&
   typeof record.receiptVendor==="string"&&normalized(record.receiptVendor)===normalized(current.vendor!)&&
   record.receiptTotalCents===current.totalCents&&typeof record.date==="string"&&
   current.dates.includes(record.date);
 });
}
