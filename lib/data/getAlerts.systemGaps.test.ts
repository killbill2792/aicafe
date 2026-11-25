import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
const rows=vi.hoisted(()=>[
  {id:"a1",kind:"meal_break",impact_cents:null,payload:{dedupeKey:"t"},status:"new",created_at:"2026-11-24T00:00:00Z"},
  {id:"a2",kind:"business_anomaly",impact_cents:null,payload:{family:"data_gap",subject:"reader_unavailable:cost_recovery"},status:"new",created_at:"2026-11-24T00:00:00Z"},
  {id:"a3",kind:"business_anomaly",impact_cents:null,payload:{family:"data_gap",subject:"sales_coverage"},status:"new",created_at:"2026-11-24T00:00:00Z"},
  {id:"a4",kind:"business_anomaly",impact_cents:null,payload:{family:"data_gap",subject:"actual_wage_coverage"},status:"new",created_at:"2026-11-24T00:00:00Z"},
]);
vi.mock("@/lib/supabase/client",()=>({isSupabaseConfigured:()=>true}));
vi.mock("@/lib/auth/requireUser",()=>({getOptionalAuthenticatedUser:async()=>({id:"owner"})}));
vi.mock("./getActiveBusinessId",()=>({getActiveBusinessId:async()=>"cafe-1"}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:async()=>({
  from:()=>{const q={select(){return q},eq(){return q},in(){return q},order:async()=>({data:rows,error:null})};return q;},
})}));
import {getOpenAlerts} from "./getAlerts";

describe("owner alert list",()=>{
  it("shows business alerts and owner-fillable gaps, never reader outages or import lag",async()=>{
    const alerts=await getOpenAlerts();
    expect(alerts.map(a=>a.id)).toEqual(["a1","a4"]);
  });
});
