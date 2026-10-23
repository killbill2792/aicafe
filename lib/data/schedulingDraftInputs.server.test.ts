import {describe,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
import {readSchedulingDraftInputs} from "./schedulingDraftInputs.server";

describe("scheduling draft input handoff",()=>{
 it("preserves confirmed bounded/overnight windows instead of promoting them to full-day leave",async()=>{
  const selections:Record<string,string>={};
  const filters:Array<{table:string;column:string;value:unknown}>=[];
  const data:Record<string,Array<Record<string,unknown>>>={
   employees:[{id:"employee-1",display_name:"Staff",default_hourly_wage_cents:1500,
     wage_period:"hour",wage_amount_cents:1500}],
   staff_schedules:[],
   staff_availability_rules:[],
   staff_scheduling_preferences:[],
   locations:[{open_hours:null,timezone:"UTC",city:null,region:null,country_code:null}],
   businesses:[{timezone:"UTC"}],
   team_rules:[],
   staff_availability_exceptions:[
    {employee_id:"employee-1",local_date:"2026-10-26",exception_type:"unavailable",
      start_local:"11:00:00",end_local:"13:00:00",overnight:false,confirmation:"owner_confirmed"},
    {employee_id:"employee-1",local_date:"2026-10-27",exception_type:"unavailable",
      start_local:"22:00:00",end_local:"02:00:00",overnight:true,confirmation:"owner_confirmed"},
    {employee_id:"employee-1",local_date:"2026-10-28",exception_type:"approved_leave",
      start_local:null,end_local:null,overnight:false,confirmation:"owner_confirmed"},
    {employee_id:"employee-1",local_date:"2026-10-29",exception_type:"unavailable",
      start_local:null,end_local:null,overnight:false,confirmation:"unconfirmed"}
   ]
  };
  const client={from(table:string){
   let rows=data[table]??[];
   const query={
    select(columns:string){selections[table]=columns;return this;},
    eq(column:string,value:unknown){
     filters.push({table,column,value});
     if(column==="confirmation")rows=rows.filter(row=>row.confirmation===value);
     return this;
    },
    order(){return this;},
    limit(n:number){return Promise.resolve({data:rows.slice(0,n),error:null});},
    single(){return Promise.resolve({data:rows[0]??null,error:null});},
    maybeSingle(){return Promise.resolve({data:rows[0]??null,error:null});}
   };
   return query;
  }} as unknown as SupabaseClient;
  const result=await readSchedulingDraftInputs(client,"cafe-1");
  expect(result.available).toBe(true);
  if(!result.available)throw new Error("Unexpected unavailable draft");
  expect(selections.staff_availability_exceptions).toContain("start_local,end_local,overnight,confirmation");
  expect(filters).toContainEqual({table:"staff_availability_exceptions",
   column:"confirmation",value:"owner_confirmed"});
  expect(result.value.unavailableDates).toEqual([
   {employeeId:"employee-1",date:"2026-10-26",start:"11:00",end:"13:00",overnight:false},
   {employeeId:"employee-1",date:"2026-10-27",start:"22:00",end:"02:00",overnight:true},
   {employeeId:"employee-1",date:"2026-10-28",start:null,end:null,overnight:false}
  ]);
 });
});
