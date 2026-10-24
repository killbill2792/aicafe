import { describe, expect, it } from "vitest";
import { describeAlert } from "./alertContent";
import type { AlertRow } from "@/lib/data/getAlerts";

const translations: Record<string,string> = {
  missingBillTitle: "Missing {category}", missingBillSubtitle:"Add it", missingBillAction:"Add the bill",
  voidsTitle:"Voids",voidsSubtitle:"Look",voidsAction:"Review voids",
  mealBreakTitle:"Break for {name}",mealBreakSubtitle:"Check shift",mealBreakAction:"Review {name}",
  someone:"Someone",unmatchedItemsTitle:"Unmatched",unmatchedItemsSubtitle:"{names}",unmatchedItemsSubtitleEmpty:"Some items need matching",
  unmatchedItemsAction:"Match items",unknownTitle:"Something needs a look",unknownSubtitle:"Review the alert",unknownAction:"Review",
};
const t = ((key:string, vars?:Record<string,string>) => (translations[key] ?? key).replace(/\{(\w+)\}/g, (_match, name:string) => vars?.[name] ?? "")) as Parameters<typeof describeAlert>[1];
const row = (kind:AlertRow["kind"], payload:Record<string,unknown> = {}):AlertRow => ({
  id:"alert-123",kind,payload,impactCents:null,status:"new",createdAt:"2026-10-23",
});
const get = (kind:AlertRow["kind"], payload?:Record<string,unknown>) => describeAlert(row(kind,payload),t,()=> "Rent");

describe("describeAlert", () => {
  it("uses the bill slot and only accepts known category codes", () => {
    expect(get("missing_bill",{categoryCode:"rent"})).toMatchObject({actionLabel:"Add the bill",actionHref:"/more/bills?category=rent",title:"Missing Rent"});
    expect(get("missing_bill",{categoryCode:"not-a-category"})).toMatchObject({title:"Something needs a look",actionLabel:"Review"});
  });
  it("reviews voids in the detail, not staff", () => {
    expect(get("voids")).toMatchObject({actionLabel:"Review voids",actionHref:"/more/alerts/alert-123#voids-review"});
  });
  it("keeps the meal break link unchanged", () => {
    expect(get("meal_break",{employeeName:"Sam",date:"2026-10-23",employeeId:"emp1"})).toMatchObject({
      actionHref:"/more/manage-staff?date=2026-10-23&employee=emp1#employee-emp1",
    });
  });
  it("directs matched and empty-name imports to Match items", () => {
    expect(get("unmatched_sales_items",{itemNames:["Latte"]})).toMatchObject({actionHref:"/menu/import-review",actionLabel:"Match items"});
    expect(get("unmatched_sales_items")).toMatchObject({subtitle:"Some items need matching"});
  });
  it.each(["early_clockin","underpriced","overstaffed","covered_milestone","not-in-enum"])("safely describes %s", (kind) => {
    expect(get(kind as AlertRow["kind"])).toMatchObject({icon:"other",title:"Something needs a look",subtitle:"Review the alert",actionLabel:"Review",actionHref:"/more/alerts/alert-123"});
  });
});