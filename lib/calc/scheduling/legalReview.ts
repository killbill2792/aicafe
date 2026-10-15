import type {PlannerInput} from "./plannerTypes";

/** Pure check of supplied policy evidence coverage. This verifies the
 * structural completeness of an owner-reviewed profile, NOT legal accuracy.
 * Regulatory accuracy must be verified externally by the café owner/adviser.
 */
export function isOliviaLegalReviewComplete(input:PlannerInput):boolean {
  const p=input.ruleProfile;
  if(!p?.verified || !p.overtime?.verified || !p.source?.trim())return false;
  if(input.locations.length===0)return false;
  if(!input.locations.every(loc=>{
    const value=p.jurisdictionByLocationId?.[loc.id];
    return typeof value==="string" && value.trim().length>0;
  }))return false;
  return input.employees.filter(e=>e.active).every(e=>{
    const value=p.classificationByEmployeeId?.[e.id];
    return typeof value==="string" && value.trim().length>0;
  });
}
