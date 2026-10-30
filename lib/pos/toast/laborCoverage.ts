/** Read-only comparison of staged Toast attendance with canonical shifts.
 * Stage NULL wage means Toast omitted it; only a successfully promoted,
 * provider-owned canonical shift may claim the corresponding $0 wage.
 * An unlinked, open or only partly promoted shift is never proof of $0 payroll.
 */
export type StagedToastShift = {
 restaurant_guid:string;external_time_entry_id:string;
 clock_in:string;clock_out:string|null;hourly_wage_cents:number|null;
 provider_regular_hours:number|null;provider_overtime_hours:number|null;
 deleted:boolean;
};
export type CanonicalToastShift = {
 pos_timecard_id:string|null;clock_in:string;clock_out:string|null;
 hourly_wage_cents:number|null;wage_source:string|null;source_type:string|null;
 provider_regular_hours:number|null;provider_overtime_hours:number|null;
};

export function hasIncompleteToastLabor(
 staged:readonly StagedToastShift[],canonical:readonly CanonicalToastShift[],
):boolean{
 const byProviderId=new Map(canonical.filter(t=>t.pos_timecard_id?.startsWith("toast:"))
  .map(t=>[t.pos_timecard_id!,t]));
 return staged.some(entry=>{
  if(entry.deleted)return false;
  // An open shift is not a certified closed-day payroll amount.
  if(!entry.clock_out)return true;
  const actual=byProviderId.get(`toast:${entry.restaurant_guid}:${entry.external_time_entry_id}`);
  if(!actual||actual.source_type!=="connected_pos"||actual.wage_source!=="pos")return true;
  const sameTime=(a:string|null,b:string|null)=>
   a===null||b===null?a===b:Date.parse(a)===Date.parse(b);
  return !sameTime(entry.clock_in,actual.clock_in)||
   !sameTime(entry.clock_out,actual.clock_out)||
   actual.hourly_wage_cents!==(entry.hourly_wage_cents??0)||
   (actual.provider_regular_hours??null)!==(entry.provider_regular_hours??null)||
   (actual.provider_overtime_hours??null)!==(entry.provider_overtime_hours??null);
 });
}
