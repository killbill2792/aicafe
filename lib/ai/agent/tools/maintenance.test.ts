import {describe,expect,it,vi} from "vitest";
import type {AgentToolContext} from "./index";
import {maintenanceTools} from "./maintenance";

function source(cases:unknown[],history:unknown[]){
  const touches:Array<{table:string;column:string;value:unknown}>=[];
  const make=(table:string,result:unknown[])=>{
    const query={
      select:()=>query,
      eq:(column:string,value:unknown)=>{touches.push({table,column,value});return query;},
      in:(column:string,value:unknown)=>{touches.push({table,column,value});return query;},
      order:()=>query,
      limit:vi.fn(async()=>({data:result,error:null})),
    };
    return query;
  };
  const db={from:vi.fn((table:string)=>make(table,table==="operating_tasks"?cases:history))};
  const ctx={canonicalData:async()=>({db,businessId:"cafe-owner"})} as unknown as AgentToolContext;
  return {ctx,db,touches};
}

describe("Task 15B canonical maintenance owner-chat reads",()=>{
  it("returns the existing saved case and limited independently sourced history, never a fabricated effect",async()=>{
    const {ctx,db,touches}=source([{
      id:"maintenance:123",status:"needs_owner",due_at:null,created_at:"2026-11-16T17:00:00Z",
      updated_at:"2026-11-16T17:01:00Z",payload:{
        equipmentLabel:"Main espresso machine",symptom:"Reported broken",
        severity:"high",maintenanceStage:"repair_claimed",
        repairVerified:false,externalSent:false,reportedAt:"2026-11-16T17:00:00Z",
      },
    }],[{
      task_id:"maintenance:123",kind:"repair_claim",source_kind:"owner_relay",
      working_confirmed:false,occurred_at:"2026-11-16T17:01:00Z",
    }]);
    const data=await maintenanceTools.get_maintenance_cases.execute({},ctx);
    expect(data).toMatchObject({source:"maintenance_cases",missing:[],agentId:"leo",cases:[{
      id:"maintenance:123",maintenanceStage:"repair_claimed",
      reportIsEquipmentTelemetry:false,externalSent:false,repairVerified:false,
      recentEvidence:[{kind:"repair_claim",independentlyWorking:false}],
    }]});
    expect(touches).toContainEqual({table:"operating_tasks",column:"business_id",value:"cafe-owner"});
    expect(touches).toContainEqual({table:"maintenance_case_events",column:"business_id",value:"cafe-owner"});
    expect(db.from).toHaveBeenCalledTimes(2);
  });
  it("returns safe unavailable evidence when no authenticated canonical reader exists",async()=>{
    const absent=await maintenanceTools.get_maintenance_cases.execute({},
      {asOf:"2026-11-16",locale:"en",timezone:"UTC",tools:{} } as unknown as AgentToolContext);
    expect(absent).toMatchObject({missing:["maintenance_source_unavailable"],cases:[]});
  });
  it("does not query irrelevant private evidence when no case exists",async()=>{
    const {ctx,db}=source([],[]);
    const data=await maintenanceTools.get_maintenance_cases.execute({},ctx);
    expect(data).toMatchObject({missing:[],cases:[],truncated:false});
    expect(db.from).toHaveBeenCalledTimes(1);
  });
});
