import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it,vi} from "vitest";
import type {PlannerShift} from "@/lib/calc/scheduling/plannerTypes";

vi.mock("next-intl",()=>({
  useLocale:()=>"en",
  useTranslations:()=> (key:string)=>key,
}));
import OliviaShiftEditor from "./OliviaShiftEditor";

const staff="50000000-0000-4000-8000-000000000005";
const location="60000000-0000-4000-8000-000000000006";
const shift:PlannerShift={
  employeeId:staff,locationId:location,
  startAt:"2099-03-02T18:00:00.000Z",endAt:"2099-03-02T22:00:00.000Z",
  paidMinutes:210,
  breaks:[{startAt:"2099-03-02T20:00:00.000Z",
    endAt:"2099-03-02T20:30:00.000Z",paid:false}],pinned:false,
};
function render(frozen:boolean){
  return renderToStaticMarkup(React.createElement(OliviaShiftEditor,{
    shifts:[shift],onChange:()=>{},employees:{[staff]:"Owner reviewed staff"},
    locations:{[location]:"America/Los_Angeles"},
    names:{[location]:"Café A"},week:"2099-03-02",
    disabled:false,
    frozenShiftKeys:frozen?[JSON.stringify([staff,location,shift.startAt])]:[],
  }));
}
describe("Olivia owner shift editor accessibility and immutability",()=>{
  it("renders labelled local-time controls and >=48px target classes",()=>{
    const html=render(false);
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain('aria-label="shiftStart"');
    expect(html).toContain('aria-label="shiftEnd"');
    expect(html).toContain("min-h-12");
    expect(html).toContain("min-w-12");
    expect(html).toContain("Owner reviewed staff");
    expect(html).toContain("Café A");
  });
  it("does not present an editable unpaid break on an immutable started shift",()=>{
    const html=render(true);
    const checkbox=html.match(/<input[^>]+type="checkbox"[^>]*>/)?.[0];
    expect(checkbox).toBeDefined();
    expect(checkbox).toContain("disabled");
    const normal=render(false).match(/<input[^>]+type="checkbox"[^>]*>/)?.[0];
    expect(normal).toBeDefined();
    expect(normal).not.toContain("disabled");
  });
});
