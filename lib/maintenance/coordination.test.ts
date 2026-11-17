import {describe,expect,it} from "vitest";
import {advanceMaintenanceCase,initialMaintenanceTransition,type MaintenanceEvent} from "./contracts";

const event=(kind:MaintenanceEvent["kind"],source:MaintenanceEvent["evidence"]["source"],
  extra:Partial<MaintenanceEvent>={}):MaintenanceEvent=>({
    kind,actor:"owner",evidence:{source,sourceId:"actual-scoped-source",observedAt:"2026-11-16T15:00:00Z"},
    ...extra,
  });

describe("Task15B maintenance evidence gates",()=>{
  it("can investigate without owner permission, but cannot claim a send",()=>{
    const stage=advanceMaintenanceCase(initialMaintenanceTransition,event("investigation","supervisor_read"));
    expect(stage.stage).toBe("investigating");
    expect(stage.externalSent).toBe(false);
    expect(()=>advanceMaintenanceCase(stage,event("vendor_send_verified","vendor_reply"))).toThrow(
      "vendor_send_not_verified");
  });
  it("requires gateway approval and provider receipt for claimed send",()=>{
    const before=advanceMaintenanceCase(initialMaintenanceTransition,
      event("owner_approval_requested","supervisor_read"));
    expect(before.stage).toBe("awaiting_owner");
    expect(()=>advanceMaintenanceCase(before,event("vendor_send_verified","gmail_effect_receipt",
      {approvalId:"owner-approval"}))).toThrow("vendor_send_not_verified");
    const sent=advanceMaintenanceCase(before,event("vendor_send_verified","gmail_effect_receipt",{
      approvalId:"owner-approval",providerReceiptId:"provider-observed-effect"}));
    expect(sent).toMatchObject({stage:"request_sent",externalSent:true,repaired:false});
  });
  it("a technician or staff repair claim does not equal a verified working machine",()=>{
    const claimed=advanceMaintenanceCase(initialMaintenanceTransition,
      event("repair_claim","vendor_reply",{actor:"vendor"}));
    expect(claimed).toMatchObject({stage:"repair_claimed",repaired:false});
    expect(()=>advanceMaintenanceCase(claimed,event("operational_verification","vendor_reply",{
      actor:"vendor",workingConfirmed:true}))).toThrow("independent_operational_check_required");
    expect(advanceMaintenanceCase(claimed,event("operational_verification",
      "owner_operational_check",{workingConfirmed:true}))).toMatchObject({
        stage:"verified_repaired",repaired:true,
      });
  });
  it("rejects premature closure and permits a verified reopening",()=>{
    expect(()=>advanceMaintenanceCase(initialMaintenanceTransition,
      event("operational_verification","owner_operational_check",{workingConfirmed:true})))
      .toThrow("repair_claim_required");
    const closed=advanceMaintenanceCase(
      advanceMaintenanceCase(initialMaintenanceTransition,event("repair_claim","staff_report",{actor:"staff"})),
      event("operational_verification","owner_operational_check",{workingConfirmed:true}));
    const reopened=advanceMaintenanceCase(closed,event("reopened","owner_report"));
    expect(reopened).toEqual({...initialMaintenanceTransition,stage:"reopened"});
  });
  it("staff assignment and owner authorization cannot be inferred from model prose",()=>{
    expect(()=>advanceMaintenanceCase(initialMaintenanceTransition,
      event("staff_assignment","staff_report"))).toThrow("staff_assignment_not_authorized");
    expect(()=>advanceMaintenanceCase(initialMaintenanceTransition,
      event("owner_approval_recorded","supervisor_read"))).toThrow("owner_approval_required");
  });
  it("rejects invented evidence and invalid dates",()=>{
    expect(()=>advanceMaintenanceCase(initialMaintenanceTransition,
      event("repair_claim","vendor_reply",{evidence:{source:"vendor_reply",sourceId:"",
        observedAt:"2026-11-16T15:00:00Z"}}))).toThrow("maintenance_evidence_missing");
  });
});
