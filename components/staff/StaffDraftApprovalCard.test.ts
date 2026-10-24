import {describe,it,expect,vi} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";

vi.mock("next-intl",()=>({
  useTranslations:()=>((key:string)=>({
    draftHeading:"Olivia's week draft",draftThisWeek:"Draft this week",close:"Close"
  } as Record<string,string>)[key]??key)
}));
vi.mock("next/navigation",()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock("@/lib/actions/staffDraftInPlace",()=>({
  draftStaffWeekInPlace:vi.fn(),reviseStaffWeekDraft:vi.fn()
}));
import StaffDraftApprovalCard from "./StaffDraftApprovalCard";
import type {RuleSettings} from "@/lib/calc/scheduling/ruleChecks";

describe("Staff Olivia draft entry",()=>{
  it("renders an in-place action without routing to Home",()=>{
    const markup=renderToStaticMarkup(createElement(StaffDraftApprovalCard,{
      week:"2026-10-26",locale:"en",
      data:{team:[],rules:{} as RuleSettings,availability:[],adjacentShifts:[],
        timezone:"America/Los_Angeles",currency:"USD"},
      onClose:()=>{},onApplied:()=>{}
    }));
    expect(markup).toContain("Olivia&#x27;s week draft");
    expect(markup).toContain("Draft this week");
    expect(markup).toContain("type=\"button\"");
    expect(markup).not.toContain("href=");
    expect(markup).not.toContain("/en");
  });
});
