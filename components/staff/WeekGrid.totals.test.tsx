import {describe,it,expect,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
vi.mock("next-intl",()=>({useTranslations:()=>((key:string)=>key)}));
import WeekGrid from "./WeekGrid";
import {shiftCost} from "@/lib/calc/scheduling/shiftCost";
import {projectVisibleStaffWeek} from "@/lib/calc/scheduling/schedulePresentation";
import type {CalendarEntry} from "@/lib/calc/scheduling/calendarEntries";
const date="2026-11-09";
const person={id:"amy",name:"Amy",role:"Barista",wageCents:2000,
 minWeeklyMinutes:null,maxWeeklyMinutes:null,availableDays:null,colorIndex:null};
const olivia={...shiftCost({employeeId:"amy",date,start:"09:00",end:"17:00",
 breakMinutes:0,wageCents:2000}),id:"approved",source:"olivia",employeeName:"Amy"};
function render(entries:CalendarEntry[]){
 const projection=projectVisibleStaffWeek({shifts:[olivia],calendarEntries:entries});
 const html=renderToStaticMarkup(<WeekGrid dates={[date]} people={[person]}
  shifts={projection.drawnShifts} costShifts={projection.laborShifts}
  toastDates={projection.toastDates} calendarEntries={entries} gaps={[]}
  openHours={null} currency="USD" readOnly={true} coverageEnabled={false}
  onAdd={vi.fn()} onEdit={vi.fn()}/>);
 return {html,projection};
}
describe("Staff desktop grid uses reconciled cost totals",()=>{
 it("shows an approved Olivia's 8 hours and wages for person and day",()=>{
  const {html,projection}=render([{id:"ai-supervisor:approved",
   employeeId:"amy",employeeName:"Amy",date,start:"09:00",end:"17:00",
   source:"ai_draft"}]);
  expect(projection.total).toMatchObject({paidMinutes:480,knownCostCents:16000});
  expect(html.match(/8 h/g)).toHaveLength(2);
  expect(html.match(/\$160\.00/g)).toHaveLength(2);
 });
 it("marks Toast-only day hours and cost as unavailable rather than zero",()=>{
  const {html}=render([{id:"toast",employeeId:"amy",employeeName:"Amy",
   date,start:"10:00",end:"18:00",source:"toast_planned"}]);
  expect(html).toContain("unknownWages");
  expect(html).not.toContain("0 h");
  expect(html).not.toContain("$0.00");
 });
});