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
 it("permits preparation before opening and cleanup after closing while retaining service coverage",()=>{
  const d=data();d.schedules=[];d.prepMinutesBeforeOpen=30;d.prepMinutesAfterClose=15;
  d.availability=d.availability.map(x=>({...x,start_local:"08:30",end_local:"12:15"}));
  const day=draftWeek(d,"2026-10-26").days[0];
  expect(day.shifts[0]).toMatchObject({start:"08:30",end:"12:15"});
  expect(day.unfilled).toEqual([]);
 });
 it("does not assign a person with a dated absence, even without a published schedule",()=>{
  const d=data();d.schedules=[];d.employees=[employee("cheap",1200)];
  d.availability=d.availability.filter(x=>x.employee_id==="cheap");
  d.unavailableDates=[{employeeId:"cheap",date:"2026-10-26"}];
  expect(draftWeek(d,"2026-10-26").days[0].unfilled).toEqual([{start:"09:00",end:"12:00",hours:3}]);
 });
 it("dated leave suppresses an existing recurring shift and permits replacement coverage",()=>{
  const d=data();d.unavailableDates=[{employeeId:"expensive",date:"2026-10-26"}];
  const monday=draftWeek(d,"2026-10-26").days[0];
  expect(monday.shifts).toEqual([{
    name:"cheap",start:"09:00",end:"12:00",paidHours:3,
    wageCentsPerHour:1200,costCents:3600,origin:"suggested",availability:"confirmed"
  }]);
  expect(monday.unfilled).toEqual([]);
  expect(monday.dayCostCents).toBe(3600);
 });
 it("absence of the only recurring worker opens the full coverage gap",()=>{
  const d=data();d.employees=[employee("expensive",2500)];
  d.availability=d.availability.filter(x=>x.employee_id==="expensive");
  d.unavailableDates=[{employeeId:"expensive",date:"2026-10-26"}];
  const monday=draftWeek(d,"2026-10-26").days[0];
  expect(monday.shifts).toEqual([]);
  expect(monday.unfilled).toEqual([{start:"09:00",end:"12:00",hours:3}]);
 });
 it("masks only midday absence, splits recurring hours and fills the gap",()=>{
  const d=data();
  d.schedules=[{employee_id:"expensive",day_of_week:1,start_time:"09:00",end_time:"17:00",
    unpaid_break_minutes:30,effective_from:"2026-01-01",effective_to:null}];
  d.openHours={mon:[["09:00","17:00"]]};
  d.availability=d.availability.map(r=>({...r,end_local:"17:00"}));
  d.unavailableDates=[{employeeId:"expensive",date:"2026-10-26",start:"11:00",end:"13:00"}];
  const result=draftWeek(d,"2026-10-26"),day=result.days[0];
  expect(day.shifts.filter(s=>s.name==="expensive")).toMatchObject([
    {origin:"recurring",start:"09:00",end:"11:00"},
    {origin:"recurring",start:"13:00",end:"17:00"}
  ]);
  expect(day.shifts).toContainEqual(expect.objectContaining({
    name:"cheap",origin:"suggested",start:"11:00",end:"13:00"
  }));
  expect(day.unfilled).toEqual([]);
  expect(result.estimated).toContain("recurringShiftAdjustedForAvailability");
 });
 it("partial absence blocks suggested coverage only during the actual interval",()=>{
  const d=data();d.schedules=[];
  d.availability=d.availability.filter(a=>a.employee_id==="cheap");
  d.unavailableDates=[{employeeId:"cheap",date:"2026-10-26",start:"10:00",end:"11:00"}];
  const day=draftWeek(d,"2026-10-26").days[0];
  expect(day.shifts).toEqual([
    expect.objectContaining({name:"cheap",start:"09:00",end:"10:00"}),
    expect.objectContaining({name:"cheap",start:"11:00",end:"12:00"})
  ]);
  expect(day.unfilled).toEqual([{start:"10:00",end:"11:00",hours:1}]);
 });
 it("overnight absence also blocks the morning of the following date",()=>{
  const d=data();d.schedules=[];
  d.availability=d.availability.filter(a=>a.employee_id==="cheap");
  d.unavailableDates=[{employeeId:"cheap",date:"2026-10-25",start:"22:00",end:"10:00",overnight:true}];
  const day=draftWeek(d,"2026-10-26").days[0];
  expect(day.unfilled).toEqual([{start:"09:00",end:"10:00",hours:1}]);
  expect(day.shifts).toEqual([expect.objectContaining({name:"cheap",start:"10:00",end:"12:00"})]);
 });
 it("does not erase legacy recurrences for unconfirmed profile-entered availability",()=>{
  const d=data();d.employees=d.employees.map(e=>e.id==="expensive"?
    {...e,available_days:[3,5]}:e);
  d.schedules=[{employee_id:"expensive",day_of_week:1,start_time:"08:00",
    end_time:"17:00",unpaid_break_minutes:30,effective_from:"2026-01-01",effective_to:null}];
  d.availability=d.availability.map(v=>v.employee_id==="expensive"?
    {...v,confirmation:"unconfirmed",source:"owner_direct"}:v);
  const monday=draftWeek(d,"2026-10-26").days[0];
  const recurring=monday.shifts.find(s=>s.name==="expensive");
  expect(recurring).toMatchObject({origin:"recurring",start:"08:00",end:"17:00",paidHours:8.5});
 });
 it("an approved Mon/Wed/Fri restriction excludes retained Tuesday recurring shifts",()=>{
  const d=data();d.employees=d.employees.map(e=>e.id==="expensive"?{...e,available_days:[3,5]}:e);
  d.availability=d.availability.map(v=>v.employee_id==="expensive"?{...v,source:"owner_direct"}:v);
  const day=draftWeek(d,"2026-10-26").days[0];
  expect(day.shifts.some(s=>s.name==="expensive")).toBe(false);
  expect(day.shifts).toContainEqual(expect.objectContaining({
   name:"cheap",origin:"suggested",start:"09:00",end:"12:00"
  }));
  expect(day.unfilled).toEqual([]);
  expect(draftWeek(d,"2026-10-26").estimated).toContain("recurringShiftAdjustedForAvailability");
 });
 it("a confirmed narrower window clips an existing recurring baseline",()=>{
  const d=data();d.employees=d.employees.map(e=>e.id==="expensive"?{...e,available_days:[1]}:e);
  d.availability=d.availability.map(v=>v.employee_id==="expensive"?{...v,source:"owner_direct"}:v);
  d.schedules=[{employee_id:"expensive",day_of_week:1,start_time:"09:00",
    end_time:"17:00",unpaid_break_minutes:30,effective_from:"2026-01-01",effective_to:null}];
  d.openHours={mon:[["09:00","17:00"]]};
  d.availability=d.availability.map(a=>a.employee_id==="expensive"?
   {...a,start_local:"10:00",end_local:"12:00"}:{...a,end_local:"17:00"});
  const day=draftWeek(d,"2026-10-26").days[0];
  expect(day.shifts.filter(x=>x.name==="expensive")).toMatchObject([
   {origin:"recurring",start:"10:00",end:"12:00"}
  ]);
  expect(day.unfilled).toEqual([]);
 });
 it("retains evening recurrences inside approved overnight availability",()=>{
  const d=data();d.employees=d.employees.map(e=>e.id==="expensive"?
    {...e,available_days:[1]}:e);
  d.schedules=[{employee_id:"expensive",day_of_week:1,start_time:"18:00",
    end_time:"23:00",unpaid_break_minutes:30,effective_from:"2026-01-01",effective_to:null}];
  d.availability=[{employee_id:"expensive",day_of_week:1,start_local:"17:00",
    end_local:"02:00",confirmation:"owner_confirmed",source:"owner_direct",
    effective_from:"2026-10-23",effective_to:null}];
  const monday=draftWeek(d,"2026-10-26").days[0];
  expect(monday.shifts).toContainEqual(expect.objectContaining({
    name:"expensive",origin:"recurring",start:"18:00",end:"23:00",paidHours:4.5
  }));
 });
 it("preserves the approved overnight spill into next-day recurring work",()=>{
  const d=data();d.employees=d.employees.map(e=>e.id==="expensive"?
    {...e,available_days:[1]}:e);
  d.schedules=[{employee_id:"expensive",day_of_week:2,start_time:"01:00",
    end_time:"02:00",unpaid_break_minutes:0,effective_from:"2026-01-01",effective_to:null}];
  d.availability=[{employee_id:"expensive",day_of_week:1,start_local:"17:00",
    end_local:"02:00",confirmation:"owner_confirmed",source:"owner_direct",
    effective_from:"2026-10-23",effective_to:null}];
  const tuesday=draftWeek(d,"2026-10-26").days[1];
  expect(tuesday.shifts).toContainEqual(expect.objectContaining({
    name:"expensive",origin:"recurring",start:"01:00",end:"02:00",paidHours:1
  }));
 });
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
