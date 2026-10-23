import {describe,it,expect} from "vitest";
import {draftWeek,nextMonday,businessLocalDate,type SchedulingDraftInputs} from "./draftWeek";
const employee=(id:string,wage:number|null)=>({id,display_name:id,default_hourly_wage_cents:wage,wage_period:"hour",wage_amount_cents:wage});
const data=():SchedulingDraftInputs=>({
 employees:[employee("expensive",2500),employee("cheap",1200)],
 schedules:[{employee_id:"expensive",day_of_week:1,start_time:"09:00",end_time:"10:00",unpaid_break_minutes:0,effective_from:"2026-01-01",effective_to:null}],
 availability:["expensive","cheap"].map(employee_id=>({employee_id,day_of_week:1,start_local:"09:00",end_local:"12:00",confirmation:"owner_confirmed",effective_from:"2026-01-01",effective_to:null})),
 preferences:[],openHours:{mon:[["09:00","12:00"]]},timezone:"America/Los_Angeles",city:null,region:null,countryCode:null
});
describe("pure scheduling draft",()=>{
 it("keeps recurring shifts and selects cheapest available for uncovered hours",()=>{
  const r=draftWeek(data(),"2026-10-26");
  expect(r.days[0].shifts[0]).toMatchObject({name:"expensive",origin:"recurring"});
  expect(r.days[0].shifts[1]).toMatchObject({name:"cheap",origin:"suggested",start:"10:00",end:"12:00"});
  expect(r.days[0].unfilled).toEqual([]);expect(r.days[0].dayCostCents).toBe(4900);
 });
 it("leaves gaps when nobody can cover",()=>{
  const d=data();d.availability=[];const r=draftWeek(d,"2026-10-26");
  expect(r.days[0].unfilled).toEqual([{start:"10:00",end:"12:00",hours:2}]);
 });
 it("keeps unknown wage as partial, not zero",()=>{
  const d=data();d.employees[1]=employee("cheap",null);
  d.availability=d.availability.map(a=>a.employee_id==="expensive"?{...a,end_local:"10:00"}:a);
  const r=draftWeek(d,"2026-10-26");
  expect(r.totals.costIsPartial).toBe(true);expect(r.days[0].dayCostCents).toBeNull();
  expect(r.totals.unknownWageNames).toContain("cheap");
  expect(r.days[0].shifts.find(s=>s.name==="cheap")?.costCents).toBeNull();
 });
 it("resolves business timezone and next Monday through week boundaries",()=>{
  expect(businessLocalDate(new Date("2026-10-26T04:00:00Z"),"America/Los_Angeles")).toBe("2026-10-25");
  expect(nextMonday("2026-10-25")).toBe("2026-10-26");
  expect(nextMonday("2026-10-26")).toBe("2026-11-02");
 });

 it("merges consecutive suggested segments by employee, preserving unconfirmed availability",()=>{
  const d=data();d.schedules=[];d.employees=[employee("cheap",1200)];
  d.availability=[
   {employee_id:"cheap",day_of_week:1,start_local:"09:00",end_local:"10:00",confirmation:"unconfirmed",effective_from:"2026-01-01",effective_to:null},
   {employee_id:"cheap",day_of_week:1,start_local:"10:00",end_local:"12:00",confirmation:"owner_confirmed",effective_from:"2026-01-01",effective_to:null}
  ];
  const r=draftWeek(d,"2026-10-26");
  expect(r.days[0].shifts).toEqual([{name:"cheap",start:"09:00",end:"12:00",paidHours:3,
   wageCentsPerHour:1200,costCents:3600,origin:"suggested",availability:"unconfirmed"}]);
  expect(r.days[0].dayCostCents).toBe(3600);
  expect(r.perPerson[0]).toMatchObject({hours:3,costCents:3600});
 });
 it("keeps one known-wage worker when a cheaper worker becomes available mid-gap",()=>{
  const d=data();d.schedules=[];d.availability=[
   {employee_id:"expensive",day_of_week:1,start_local:"09:00",end_local:"12:00",confirmation:"owner_confirmed",effective_from:"2026-01-01",effective_to:null},
   {employee_id:"cheap",day_of_week:1,start_local:"10:00",end_local:"12:00",confirmation:"owner_confirmed",effective_from:"2026-01-01",effective_to:null}
  ];
  const r=draftWeek(d,"2026-10-26");
  expect(r.days[0].shifts).toHaveLength(1);
  expect(r.days[0].shifts[0]).toMatchObject({name:"expensive",start:"09:00",end:"12:00"});
 });
 it("uses default 2400-minute cap when 39 hours are already scheduled",()=>{
  const d=data();d.employees=[employee("cheap",1200)];d.preferences=[];
  d.schedules=[...Array.from({length:4},(_,i)=>({
   employee_id:"cheap",day_of_week:i+1,start_time:"09:00",end_time:"17:00",
   unpaid_break_minutes:0,effective_from:"2026-01-01",effective_to:null
  })),{employee_id:"cheap",day_of_week:5,start_time:"09:00",end_time:"16:00",
    unpaid_break_minutes:0,effective_from:"2026-01-01",effective_to:null}];
  d.openHours={fri:[["16:00","18:00"]]};
  d.availability=[{employee_id:"cheap",day_of_week:5,start_local:"16:00",end_local:"18:00",
   confirmation:"owner_confirmed",effective_from:"2026-01-01",effective_to:null}];
  const r=draftWeek(d,"2026-10-26");
  expect(r.totals.hours).toBe(39);
  expect(r.days[4].unfilled).toEqual([{start:"16:00",end:"18:00",hours:2}]);
  expect(r.days[4].shifts.filter(s=>s.origin==="suggested")).toEqual([]);
 });
 it("chooses latest effective preference then smallest weekly cap regardless of input order",()=>{
  const d=data();d.schedules=[];d.employees=[employee("cheap",1200)];
  d.availability=d.availability.filter(a=>a.employee_id==="cheap");
  const old={employee_id:"cheap",effective_from:"2026-01-01",effective_to:null,max_weekly_minutes:2400};
  const recent={...old,effective_from:"2026-10-20",max_weekly_minutes:120};
  const restrictive={...recent,max_weekly_minutes:0};
  for(const permutation of [[old,restrictive,recent],[recent,old,restrictive],[restrictive,recent,old]]){
   d.preferences=permutation;
   expect(draftWeek(d,"2026-10-26").days[0].unfilled).toEqual([{start:"09:00",end:"12:00",hours:3}]);
  }
 });
 it("flags only actual UTC fallback, not a configured UTC timezone",()=>{
  const d=data();d.timezone="UTC";
  expect(draftWeek(d,"2026-10-26").estimated).not.toContain("timezoneDefaultedToUtc");
  d.timezoneDefaultedToUtc=true;
  expect(draftWeek(d,"2026-10-26").estimated).toContain("timezoneDefaultedToUtc");
 });
 it("respects 40-hour weekly cap",()=>{
  const d=data();d.preferences=[{employee_id:"cheap",max_weekly_minutes:0,effective_from:"2026-01-01",effective_to:null}];
  d.availability=d.availability.filter(x=>x.employee_id==="cheap");
  expect(draftWeek(d,"2026-10-26").days[0].unfilled).toHaveLength(1);
 });
});
