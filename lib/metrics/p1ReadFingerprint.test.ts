import { describe,expect,it } from "vitest";
import { fingerprintP1Observation } from "./p1ReadFingerprint";

const base={
  businessId:"cafe-a",readerId:"readP1EmployeeWages",
  selectorId:"labor.employee_wages.selector",selectorVersion:1,
  purpose:"authorized_owner_wage_review",
  query:{id:"labor.employee_wages",version:1,purpose:"authorized_owner_wage_review"},
  value:[{id:"sophie",name:"Sophie",defaultHourlyWageCents:1800}],
  quality:{missingInputs:[],estimatedInputs:[],staleInputs:[]},
};
describe("P1 observed content fingerprint is not an authoritative source revision",()=>{
  it("is deterministic under semantically identical object key order",()=>{
    const original=fingerprintP1Observation(base);
    expect(original).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fingerprintP1Observation({...base,
      query:{purpose:"authorized_owner_wage_review",version:1,id:"labor.employee_wages"},
    })).toBe(original);
  });
  it("changes when selected tenant, wage, purpose, quality or reader contract changes",()=>{
    const first=fingerprintP1Observation(base);
    for(const changed of [
      {...base,businessId:"cafe-b"},
      {...base,value:[{id:"sophie",name:"Sophie",defaultHourlyWageCents:2200}]},
      {...base,purpose:"unrelated_context"},
      {...base,quality:{missingInputs:["salary_unknown"],estimatedInputs:[],staleInputs:[]}},
      {...base,selectorVersion:2},
    ])expect(fingerprintP1Observation(changed)).not.toBe(first);
  });
  it("refuses a missing tenant scope or oversized read payload",()=>{
    expect(()=>fingerprintP1Observation({...base,businessId:""}))
      .toThrow("unscoped_read_fingerprint");
    expect(()=>fingerprintP1Observation({...base,value:"x".repeat(500_001)}))
      .toThrow("unbounded_read_fingerprint");
  });
});
