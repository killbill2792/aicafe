import {describe,it,expect,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
vi.mock("next-intl",()=>({useTranslations:()=>((key:string)=>key)}));
import WeekGrid from "./WeekGrid";
import type {CalendarEntry} from "@/lib/calc/scheduling/calendarEntries";
const entries:CalendarEntry[]=[
 {id:"a",employeeId:null,employeeName:"Unlinked Toast cashier",
  date:"2026-11-09",start:"08:00",end:"12:00",source:"toast_planned"},
 {id:"b",employeeId:null,employeeName:"Unlinked Toast cashier",
  date:"2026-11-09",start:"08:10",end:"12:05",source:"toast_actual"}
];
describe("desktop Staff grid for unlinked Toast staff",()=>{
 it("renders a read-only single worker row with both real Toast evidence labels",()=>{
  const html=renderToStaticMarkup(<WeekGrid
   dates={["2026-11-09"]} people={[]} shifts={[]} calendarEntries={entries}
   gaps={[]} openHours={null} currency="USD" readOnly={false}
   coverageEnabled={false} onAdd={vi.fn()} onEdit={vi.fn()}/>);
  expect(html).toContain("Unlinked Toast cashier");
  expect(html).toContain("toastPlannedLabel");
  expect(html).toContain("toastActualLabel");
  expect(html.match(/Unlinked Toast cashier/g)).toHaveLength(1);
  expect(html).toContain("disabled");
 });
});