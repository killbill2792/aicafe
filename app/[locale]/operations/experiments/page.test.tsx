import {describe,expect,it,vi} from "vitest";
import {createElement,type ReactNode} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {buildExperimentsList} from "@/lib/operating/experiments";

vi.mock("server-only",()=>({}));
vi.mock("next-intl/server",()=>({getLocale:async()=>"en",
  getTranslations:async()=>(key:string,params?:Record<string,unknown>)=>key+(params?JSON.stringify(params):"")}));
vi.mock("@/i18n/navigation",()=>({Link:({children,href}:{children:ReactNode;href:string})=>createElement("a",{href},children)}));
vi.mock("@/components/shared/PageShell",()=>({default:({children}:{children:ReactNode})=>createElement("main",null,children)}));
vi.mock("@/components/shared/EstimatePill",()=>({default:({label}:{label:string})=>createElement("span",null,label)}));
vi.mock("@/lib/auth/requireUser",()=>({requireOwnBusiness:async()=>({id:"owner"})}));
vi.mock("@/lib/data/getActiveBusinessId",()=>({getActiveBusinessId:async()=>"cafe"}));
vi.mock("@/lib/ai/cafeTools.server",()=>({readSupervisorCafeIdentity:async()=>({currency:"USD",asOf:"2026-11-04"})}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:async()=>({})}));
const latte=(id:string,start:string,oldP:number,newP:number)=>({id,thread_id:"t-"+id,status:"manual_confirmed",
  capability_id:"alex.drink_price_experiment.v1",canonical_effect_payload:{productId:"latte",productName:"Latte",oldPriceCents:oldP,newPriceCents:newP,baselineUnits7Days:140},
  baseline:{estimatedAdditionalRevenue7DaysCents:1400},monitor_spec:{durationDays:7,metricScope:"latte"},monitoring_start_date:start});
vi.mock("@/lib/operating/experiments.server",()=>({readExperiments:async()=>buildExperimentsList(
  [latte("a","2026-10-31",775,785),latte("b","2026-11-05",785,795)],[],
  [{proposal_id:"a",business_date:"2026-10-31",observation:{units:20,netSalesCents:15700,coverage:"actual"}}],"2026-11-04")}));

import ExperimentsPage from "./page";

describe("Experiments page",()=>{
  it("shows both running latte tests with dates, baseline, daily readings, the overlap note and a thread link",async()=>{
    const html=renderToStaticMarkup(await ExperimentsPage());
    expect(html).toContain('id="experiment-a"');
    expect(html).toContain('id="experiment-b"');
    expect(html).toContain('stageDay{&quot;day&quot;:&quot;5&quot;,&quot;days&quot;:&quot;7&quot;,&quot;range&quot;:&quot;range{');
    expect(html).toContain('priceTitle{&quot;item&quot;:&quot;Latte&quot;,&quot;old&quot;:&quot;$7.75&quot;,&quot;new&quot;:&quot;$7.85&quot;}');
    expect(html).toContain('baselineUnits{&quot;units&quot;:&quot;140&quot;}');
    expect(html).toContain('data-sample-date="2026-10-31"');
    expect(html).toContain("$157.00");
    expect(html.match(/overlap/g)).toHaveLength(2);
    expect(html).toContain('href="/?thread=t-a&amp;experiment=a"');
  });
});
