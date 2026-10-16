import { randomUUID, createHash } from "node:crypto";
import { availabilityBatchSchema } from "./availabilityBatchSchemas";
import { foundationRecordSchemas } from "./foundationSchemas";
import type { OliviaPrepareAvailability, OliviaPreparedAvailability } from "./oliviaCommandContracts";
import type { OliviaReadResponse } from "./oliviaCapabilityContracts";

/**
 * Pure intent-to-record reconciliation. Never constructs an employee or
 * overwrites a whole employee's availability when only one scope was edited.
 */
export function oliviaProposalDigest(proposal: OliviaPreparedAvailability): string {
  return createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
}

type Employee = Extract<OliviaReadResponse, {ok:true;capability:"olivia.availability.read"}>["employees"][number];
type Failure = "invalid_input" | "not_found" | "ambiguous_employee" |
  "inactive_employee" | "revision_conflict" | "invalid_record";
export type ProposalResult =
  | {ok:true;proposal:OliviaPreparedAvailability;proposalDigest:string;
      changes:Array<{employeeId:string;employeeName:string;kind:string;
        locationId:string|null;scope:object;countBefore:number;countAfter:number}>}
  | {ok:false;error:Failure};

const identity = (s:string) => s.normalize("NFKC").trim().toLocaleLowerCase("en-US");
const isSameScope = (
  row:Record<string,unknown>, change:OliviaPrepareAvailability["changes"][number],
) => {
  if((row.location_id ?? null)!==change.locationId)return false;
  if(change.kind==="availability_rule")
    return row.effective_from===change.scope.effective_from &&
      (row.effective_to??null)===change.scope.effective_to;
  return row.local_date===change.scope.local_date;
};
const cleanRecord=(kind:"availability_rule"|"availability_exception",row:unknown) => {
  if(row===null || typeof row!=="object")return null;
  const value=row as Record<string,unknown>;
  const keys=Object.keys(foundationRecordSchemas[kind].shape);
  const data=Object.fromEntries(keys.filter(k=>k in value).map(k=>[k,value[k]]));
  const parsed=foundationRecordSchemas[kind].safeParse(data);
  return parsed.success?parsed.data:null;
};

/** The read is already authenticated and tenancy-verified by Olivia PR4A. */
export function reconcileOliviaAvailability(
  request:OliviaPrepareAvailability, employees:readonly Employee[],
  businessId:string, sourceToken:string,
  newKey:()=>string=randomUUID,
):ProposalResult {
  const batches:unknown[]=[];
  const descriptions:Extract<ProposalResult,{ok:true}>["changes"]=[];
  const seenScopes=new Set<string>();
  for(const change of request.changes){
    const matched=("employeeId" in change.employee)
      ? employees.filter(e=>e.employeeId===change.employee.employeeId)
      : employees.filter(e=>identity(e.displayName)===identity(change.employee.exactDisplayName));
    if(!matched.length)return {ok:false,error:"not_found"};
    if(matched.length!==1)return {ok:false,error:"ambiguous_employee"};
    const person=matched[0];
    if(!person.active)return {ok:false,error:"inactive_employee"};
    const scopeKey=JSON.stringify([person.employeeId,change.locationId,change.kind,change.scope]);
    if(seenScopes.has(scopeKey))return {ok:false,error:"invalid_input"};
    seenScopes.add(scopeKey);
    const existing=(change.kind==="availability_rule"?person.recurring:person.exceptions)
      .filter(x=>isSameScope(x as Record<string,unknown>,change));
    if(existing.length>200)return {ok:false,error:"invalid_input"};
    const byId=new Map(existing.map(x=>[x.id,x]));
    if(byId.size!==existing.length)return {ok:false,error:"invalid_record"};
    const touched=new Set<string>();
    const desired: Array<{id?:string;data:Record<string,unknown>}>=[];
    for(const op of change.operations){
      if(op.action==="add"){
        const data=cleanRecord(change.kind,{
          ...op.data,employee_id:person.employeeId,location_id:change.locationId,
          ...change.scope,confirmation:"owner_confirmed",
        });
        if(!data)return {ok:false,error:"invalid_input"};
        desired.push({data});
      }else{
        if(touched.has(op.id))return {ok:false,error:"invalid_input"};
        touched.add(op.id);
        const stored=byId.get(op.id);
        if(!stored)return {ok:false,error:"not_found"};
        if(stored.revision!==op.expectedRevision)
          return {ok:false,error:"revision_conflict"};
        if(op.action==="replace"){
          const data=cleanRecord(change.kind,{
            ...op.data,employee_id:person.employeeId,location_id:change.locationId,
            ...change.scope,confirmation:"owner_confirmed",
          });
          if(!data)return {ok:false,error:"invalid_input"};
          desired.push({id:op.id,data});
        }
      }
    }
    // Preserve every other window within this EXACT date/period/location.
    // PR1B replaces whole scopes atomically, not arbitrary individual rows.
    for(const row of existing){
      if(touched.has(row.id))continue;
      const data=cleanRecord(change.kind,row);
      if(!data)return {ok:false,error:"invalid_record"};
      desired.push({id:row.id,data});
    }
    if(desired.length>200)return {ok:false,error:"invalid_input"};
    const expected=existing.map(r=>({id:r.id,revision:r.revision}))
      .sort((a,b)=>a.id.localeCompare(b.id));
    desired.sort((a,b)=>(a.id??"~").localeCompare(b.id??"~") ||
      JSON.stringify(a.data).localeCompare(JSON.stringify(b.data)));
    const candidate=availabilityBatchSchema.safeParse({
      kind:change.kind,employeeId:person.employeeId,locationId:change.locationId,
      scope:change.scope,expected,desired,requestKey:newKey(),
    });
    if(!candidate.success)return {ok:false,error:"invalid_input"};
    batches.push(candidate.data);
    descriptions.push({employeeId:person.employeeId,employeeName:person.displayName,
      kind:change.kind,locationId:change.locationId,scope:change.scope,
      countBefore:existing.length,countAfter:desired.length});
  }
  const proposal:OliviaPreparedAvailability={
    capability:"olivia.availability.commit",version:1,disposition:
      "requires_separate_authenticated_owner_action",
    businessId,sourceToken,batches:batches as OliviaPreparedAvailability["batches"],
  };
  return {ok:true,proposal,proposalDigest:oliviaProposalDigest(proposal),
    changes:descriptions};
}
