import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
const spies=vi.hoisted(()=>({generate:vi.fn(),reads:[] as string[]}));
vi.mock("@/lib/supabase/client",()=>({isSupabaseConfigured:()=>true}));
vi.mock("@/lib/auth/requireUser",()=>({getOptionalAuthenticatedUser:async()=>({id:"owner"})}));
vi.mock("./getActiveBusinessId",()=>({getActiveBusinessId:async()=>"cafe-1"}));
vi.mock("@/lib/alerts/generate",()=>({generateAlerts:spies.generate}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:async()=>({
  from:(table:string)=>{
    spies.reads.push(table);
    const q={select(){return q},eq(){return q},in(){return q},
      order:async()=>({data:[],error:null})};
    return q;
  },
})}));
import {getOpenAlerts} from "./getAlerts";
describe("getAlerts read-only",()=>{
  it("does not regenerate even real-owner alerts on Home or Alerts load",async()=>{
    spies.reads.length=0;spies.generate.mockClear();
    expect(await getOpenAlerts()).toEqual([]);
    expect(spies.generate).not.toHaveBeenCalled();
    expect(spies.reads).toEqual(["alerts"]);
  });
});
