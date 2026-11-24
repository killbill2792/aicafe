import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supervisorHistoricalReaders } from "./supervisorReads.server";

vi.mock("server-only",()=>({}));
const BUSINESS="11111111-1111-4111-8111-111111111111";
const day={from:"2026-10-25",to:"2026-10-25"};

function source(records:Array<{id?:string;employee_id:string|null;clock_in:string;clock_out:string|null;source_type:string}>) {
  const reads:string[]=[];
  const client={
    from(table:string){
      reads.push(table);
      if(table==="timecards"){
        let head=false,filterClock=false,employees:string[]|null=null;
        const q={
          select:(_columns:string,opts?:{head?:boolean})=>{head=opts?.head===true;return q;},
          eq:()=>q,gte:()=>q,lte:()=>q,neq:()=>q,order:()=>q,
          is:(field:string)=>{if(field==="clock_out")filterClock=true;return q;},
          in:(field:string,ids:string[])=>{if(field==="employee_id")employees=ids;return q;},
          range:async(start:number,end:number)=>{
            const filtered=records.filter(row=>row.source_type!=="owner_schedule");
            return {data:filtered.slice(start,end+1),count:filtered.length,error:null};
          },
          then:(fn:(v:unknown)=>unknown)=>{
            const filtered=records.filter(row=>row.source_type!=="owner_schedule"&&
              (!filterClock||row.clock_out===null)&&
              (employees===null||row.employee_id!==null&&employees.includes(row.employee_id)));
            return Promise.resolve({data:head?null:filtered,count:filtered.length,error:null}).then(fn);
          }
        };
        return q;
      }
      if(table==="employees"){
        const q={
          select:()=>q,eq:()=>q,in:()=>q,order:()=>q,
          range:async(start:number,end:number)=>({
            data:[{id:"current",display_name:"Sam"}].slice(start,end+1),error:null
          }),
          limit:async()=>({data:[{id:"current",display_name:"Sam"}],error:null}),
        };
        return q;
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
  it("reports actual punch times and missing recorded breaks without asserting missed meals",async()=>{
    const data=[
      {...card("current","2026-10-25T23:00:00Z"),breaks:[]},
      {...card("archived",null),breaks:null},
      {...card("current","2026-10-25T20:00:00Z"),breaks:[{
        start:"2026-10-25T18:00:00Z",end:"2026-10-25T18:30:00Z",
      }]},
    ];
    const {client}=source(data);
    const result=await supervisorHistoricalReaders(client,BUSINESS).staffAttendance(
      BUSINESS,day,"America/Los_Angeles");
    expect(result.available).toBe(true);
    if(!result.available)return;
    expect(result.value.recordedTimecards).toHaveLength(3);
    const noPunch=result.value.recordedTimecards?.find(x=>x.clockOut==="2026-10-25T23:00:00Z");
    expect(noPunch).toMatchObject({
      employeeName:"Sam",localDate:"2026-10-25",elapsedHours:6,
      breakEvidence:"none_recorded",recordedBreakCount:0,
    });
    expect(result.value.recordedTimecards?.find(x=>x.clockOut===null)).toMatchObject({
      elapsedHours:null,breakEvidence:"unknown",
    });
    expect(result.value.recordedTimecards?.find(x=>x.clockOut==="2026-10-25T20:00:00Z"))
      .toMatchObject({breakEvidence:"recorded",recordedBreakCount:1});
  });
  it("traverses all 217 recorded punches in pages and reports the complete source count",async()=>{
    const records=Array.from({length:217},(_,i)=>({
      ...card("current",i%2===0?null:"2026-10-25T19:00:00Z"),
      id:"synthetic-punch-"+i,breaks:[],
    }));
    const {client}=source(records);
    const reader=supervisorHistoricalReaders(client,BUSINESS);
    const pages=await Promise.all([0,100,200].map(offset=>
      reader.staffAttendance(BUSINESS,day,"America/Los_Angeles",offset)));
    for(const p of pages)expect(p.available).toBe(true);
    const [first,second,last]=pages.map(p=>p.value!);
    expect([first.recordedTimecards?.length,second.recordedTimecards?.length,
      last.recordedTimecards?.length]).toEqual([100,100,17]);
    expect(pages.map(p=>p.value?.timecardCount)).toEqual([217,217,217]);
    expect(first.recordedTimecardsNextOffset).toBe(100);
    expect(second.recordedTimecardsNextOffset).toBe(200);
    expect(last.recordedTimecardsNextOffset).toBe(null);
    expect(last.recordedTimecardsPageComplete).toBe(true);
    expect(first.onClockCount).toBe(109);
    expect(new Set(pages.flatMap(p=>p.value?.recordedTimecards?.map(t=>t.timecardId)??[])).size).toBe(217);
  });
  it("rejects a different business before consulting timecards",async()=>{
    const {client,reads}=source([]);
    await expect(supervisorHistoricalReaders(client,BUSINESS).staffAttendance(
      "22222222-2222-4222-8222-222222222222",day,"America/Los_Angeles"
    )).rejects.toThrow("scope mismatch");
    expect(reads).toEqual([]);
  });
});

describe("shifts with no hourly wage",()=>{
  function withUnpaid(rows:unknown[]|"error"){
    const q=(data:unknown)=>{const query:Record<string,unknown>={};
      for(const k of ["select","eq","gte","lte","order","in","neq","is"])query[k]=()=>query;
      query.limit=async()=>data;
      query.range=async()=>({...data,count:Array.isArray((data as {data?:unknown[]}).data)?
        (data as {data:unknown[]}).data.length:null});
      query.then=(yes:(v:unknown)=>unknown)=>Promise.resolve(data).then(yes);
      return query;};
    return {from(table:string){
      if(table==="timecards")return q({data:[card("current","2026-10-12T18:00:00Z")],error:null});
      if(table==="employees")return q({data:[{id:"current",display_name:"Sam"}],error:null});
      if(table==="cv_labor_entries")return q(rows==="error"?{data:null,error:{code:"42P01"}}:{data:rows,error:null});
      throw new Error("unexpected table "+table);
    }} as unknown as SupabaseClient;
  }
  const month={from:"2026-10-01",to:"2026-10-28"};
  it("names each finished shift that has no wage, so the owner is asked only about those",async()=>{
    const client=withUnpaid([
      {business_date:"2026-10-12",data:{employee_id:"current"},regular_hours:6.5,overtime_hours:0},
      {business_date:"2026-10-14",data:{employee_guid:"toast-guid"},regular_hours:null,overtime_hours:null},
    ]);
    const result=await supervisorHistoricalReaders(client,BUSINESS).staffAttendance(BUSINESS,month,"America/Los_Angeles");
    expect(result.available).toBe(true);
    if(!result.available)return;
    expect(result.value.missingWageShifts).toEqual([
      {date:"2026-10-12",employeeName:"Sam",hours:6.5},
      {date:"2026-10-14",employeeName:null,hours:null},
    ]);
  });
  it("never claims every wage is known when the labor view cannot be read",async()=>{
    const result=await supervisorHistoricalReaders(withUnpaid("error"),BUSINESS)
      .staffAttendance(BUSINESS,month,"America/Los_Angeles");
    expect(result.available).toBe(true);
    if(!result.available)return;
    expect(result.value.missingWageShifts).toBeUndefined();
    expect(result.quality.missingInputs).toContain("missingWageShiftsUnavailable");
    expect(result.value.timecardCount).toBe(1);
  });
});
