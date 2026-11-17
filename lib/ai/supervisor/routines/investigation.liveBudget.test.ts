import {describe,expect,it} from "vitest";
import {emptyInvestigationLiveLedger,reserveInvestigationLiveCall,
  INVESTIGATION_LIVE_MAX_CALLS,INVESTIGATION_LIVE_MAX_BYTES,
  INVESTIGATION_LIVE_MAX_OUTPUT_PER_CALL,INVESTIGATION_LIVE_MAX_RESERVED_MICROS}
  from "./investigation.liveBudget";

describe("Task15A paid proactive runner: hard pretransport reservation",()=>{
  it("charges a worst-case serialized-byte token, full output cap and replay",()=>{
    const first=reserveInvestigationLiveCall(emptyInvestigationLiveLedger(),1000,1200,"gpt-6-luna");
    expect(first).toEqual({calls:1,bytes:1000,reservedMicros:700});
    const second=reserveInvestigationLiveCall(first,1000,800,"gpt-6-luna");
    expect(second).toEqual({calls:2,bytes:2000,reservedMicros:1320});
    expect(first).toEqual({calls:1,bytes:1000,reservedMicros:700});
  });
  it("rejects a single unpriceable long-context call rather than treating it as Luna short-context",()=>{
    expect(()=>reserveInvestigationLiveCall(emptyInvestigationLiveLedger(),
      272_001,1,"gpt-6-luna")).toThrow("15a_live_model_unpriced_or_mismatched");
  });
  it("never issues a thirteenth provider transport",()=>{
    let ledger=emptyInvestigationLiveLedger();
    for(let i=0;i<INVESTIGATION_LIVE_MAX_CALLS;i++)
      ledger=reserveInvestigationLiveCall(ledger,1000,1200,"gpt-6-luna");
    expect(ledger.calls).toBe(12);
    expect(()=>reserveInvestigationLiveCall(ledger,1000,1200,"gpt-6-luna"))
      .toThrow("15a_live_provider_budget_exceeded");
  });
  it("rejects the first byte above the cumulative input cap",()=>{
    // Standard rate helper deliberately rejects per-call long context;
    // accumulate several normally priced requests to test the byte ceiling.
    let ledger=emptyInvestigationLiveLedger();
    for(let i=0;i<3;i++)
      ledger=reserveInvestigationLiveCall(ledger,200_000,1,"gpt-6-luna");
    expect(ledger.bytes).toBe(INVESTIGATION_LIVE_MAX_BYTES);
    expect(()=>reserveInvestigationLiveCall(ledger,1,1,"gpt-6-luna"))
      .toThrow("15a_live_provider_budget_exceeded");
  });
  it("refuses excess output tokens and malformed ledgers before transport",()=>{
    expect(()=>reserveInvestigationLiveCall(emptyInvestigationLiveLedger(),1,
      INVESTIGATION_LIVE_MAX_OUTPUT_PER_CALL+1,"gpt-6-luna")).toThrow("15a_live_invalid_budget");
    expect(()=>reserveInvestigationLiveCall(emptyInvestigationLiveLedger(),0,1,"gpt-6-luna"))
      .toThrow("15a_live_invalid_budget");
    expect(()=>reserveInvestigationLiveCall({calls:-1,bytes:0,reservedMicros:0},1,1,"gpt-6-luna"))
      .toThrow("15a_live_invalid_budget");
  });
  it("rejects alternate or unpriced models before a paid call",()=>{
    for(const model of ["gpt-6-sol","gpt-6-astra","gpt-4.1-mini","unknown",""]){
      expect(()=>reserveInvestigationLiveCall(emptyInvestigationLiveLedger(),
        3000,1200,model)).toThrow("15a_live_model_unpriced_or_mismatched");
    }
    const valid=reserveInvestigationLiveCall(emptyInvestigationLiveLedger(),3000,1200,"gpt-6-luna");
    expect(valid.reservedMicros).toBe(900);
  });
  it("keeps the monetary ceiling even if call and byte ceilings are under cap",()=>{
    const near={calls:1,bytes:1,
      reservedMicros:INVESTIGATION_LIVE_MAX_RESERVED_MICROS-1};
    expect(()=>reserveInvestigationLiveCall(near,1,1,"gpt-6-luna"))
      .toThrow("15a_live_provider_budget_exceeded");
    expect(near.reservedMicros).toBe(INVESTIGATION_LIVE_MAX_RESERVED_MICROS-1);
  });
  it("rejects max-bytes and max-output transport without rounding down spend",()=>{
    let ledger=emptyInvestigationLiveLedger();
    for(let i=0;i<3;i++)
      ledger=reserveInvestigationLiveCall(ledger,200_000,
        INVESTIGATION_LIVE_MAX_OUTPUT_PER_CALL,"gpt-6-luna");
    expect(ledger.bytes).toBe(INVESTIGATION_LIVE_MAX_BYTES);
    expect(ledger.reservedMicros).toBeGreaterThan(0);
    expect(ledger.reservedMicros).toBeLessThanOrEqual(
      INVESTIGATION_LIVE_MAX_RESERVED_MICROS);
    expect(()=>reserveInvestigationLiveCall(ledger,1,1,"gpt-6-luna"))
      .toThrow("15a_live_provider_budget_exceeded");
  });
});
