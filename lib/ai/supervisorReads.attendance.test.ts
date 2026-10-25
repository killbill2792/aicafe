import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supervisorHistoricalReaders } from "./supervisorReads.server";

vi.mock("server-only",()=>({}));
const BUSINESS="11111111-1111-4111-8111-111111111111";
const day={from:"2026-10-25",to:"2026-10-25"};

function source(records:Array<{employee_id:string|null;clock_in:string;clock_out:string|null;source_type:string}>) {
  const reads:string[]=[];
  const client={
    from(table:string){
      reads.push(table);
      if(table==="timecards"){
        const query={
          select:()=>query,eq:()=>query,gte:()=>query,lte:()=>query,
          limit:async()=>({data:records,error:null}),
        };
        return query;
      }
      if(table==="employees"){
        const query={
          select:()=>query,eq:()=>query,
          limit:async()=>({data:[{id:"current"}],error:null}),
        };
        return query;
      }
      throw new Error("unexpected table "+table);
    },
  } as unknown as SupabaseClient;
  return {client,reads};
}
function card(employee_id:string|null,clock_out:string|null,source_type="connected_pos"){
  return {employee_id,clock_in:"2026-10-25T17:00:00Z",clock_out,source_type};
}

describe("historical attendance versus active on-clock roster",()=>{
  it("preserves completed archived and unlinked attendance while counting only active on-clock staff",async()=>{
    const {client}=source([
      card("archived","2026-10-25T18:00:00Z"),
      card(null,"2026-10-25T18:00:00Z","imported"),
      card("current",null),
      card("current","2026-10-25T19:00:00Z","owner_schedule"),
    ]);
    const result=await supervisorHistoricalReaders(client,BUSINESS).staffAttendance(BUSINESS,day,"America/Los_Angeles");
    expect(result.available).toBe(true);
    if(!result.available)return;
    expect(result.value.timecardCount).toBe(3);
    expect(result.value.onClockCount).toBe(1);
    expect(result.value.attendanceTracked).toBe(true);
  });
  it("retains evidence of real attendance even if every recorded employee has been deactivated",async()=>{
    const {client}=source([card("archived","2026-10-25T18:00:00Z")]);
    const result=await supervisorHistoricalReaders(client,BUSINESS).staffAttendance(BUSINESS,day,"America/Los_Angeles");
    expect(result.available).toBe(true);
    if(!result.available)return;
    expect(result.value.timecardCount).toBe(1);
    expect(result.value.onClockCount).toBe(0);
    expect(result.value.attendanceTracked).toBe(true);
  });
  it("rejects a different business before consulting timecards",async()=>{
    const {client,reads}=source([]);
    await expect(supervisorHistoricalReaders(client,BUSINESS).staffAttendance(
      "22222222-2222-4222-8222-222222222222",day,"America/Los_Angeles"
    )).rejects.toThrow("scope mismatch");
    expect(reads).toEqual([]);
  });
});
