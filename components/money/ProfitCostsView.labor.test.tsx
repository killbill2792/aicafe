import {describe,it,expect,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {getFixtureSnapshot} from "@/lib/data/fixtureSnapshot";
import type {ReactNode} from "react";
import ProfitCostsView from "./ProfitCostsView";

vi.mock("next-intl/server",()=>({
  getTranslations:async()=>((key:string)=>key),
  getLocale:async()=>"en",
}));
vi.mock("@/i18n/navigation",()=>({
  Link:({children,href}:{children:ReactNode;href:string})=><a href={href}>{children}</a>,
}));
vi.mock("@/components/shared/Money",()=>({
  default:({cents}:{cents:number|null})=><span>{cents===null?"unknown":String(cents)}</span>,
}));

describe("ProfitCostsView incomplete POS wages",()=>{
  it("does not render a complete staff flow bar or profit when partial wages are non-null",async()=>{
    const complete=getFixtureSnapshot();
    const date=complete.todayDay.date;
    const partial={...complete.todayDay,wagesCents:1250,staffTaxCents:150,
      laborWageStatus:"missing" as const};
    const snapshot={...complete,todayDay:partial,
      monthActualDays:complete.monthActualDays.map(d=>d.date===date?partial:d),
      monthRecordedDays:complete.monthActualDays.map(d=>d.date===date?partial:d)};
    const html=renderToStaticMarkup(await ProfitCostsView({
      snapshot,period:"today",salesSources:["toast"]}));
    expect(html).toContain("ownerProfitWaiting");
    expect(html).toContain("staff:");
    expect(html).not.toContain("STAFF</span><span class=\"text-[13px] font-bold text-ink-muted\">0%");
    expect(html).not.toContain("rounded-md bg-staff");
    const completeHtml=renderToStaticMarkup(await ProfitCostsView({
      snapshot:complete,period:"today",salesSources:["toast"]}));
    expect(completeHtml).toContain("rounded-md bg-staff");
  });
});
