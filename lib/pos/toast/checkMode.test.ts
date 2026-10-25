import {beforeEach,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
const probe=vi.hoisted(()=>vi.fn());
vi.mock("./analyticsClient",()=>({createToastAnalyticsClient:(_db:unknown,b:string)=>({test:(...args:unknown[])=>probe(b,...args)})}));
import {detectToastCheckMode} from "./checkMode";
import {ToastApiError} from "./client";
function fixture(){
 const modes:Record<string,Record<string,unknown>>={A:{toast_check_mode:"internal",mode_checked_at:null},B:{toast_check_mode:"official",mode_checked_at:new Date().toISOString()}};
 const analytics:Record<string,Record<string,unknown>>={A:{business_id:"A",verified_at:null},B:{business_id:"B",verified_at:"before"}};
 const db={async rpc(name:string,args:{p_business_id:string}){
  if(name!=="toast_enable_official_check")throw Error("unexpected RPC");
  const b=args.p_business_id;
  if(!analytics[b]?.verified_at)return {data:false,error:null};
  Object.assign(modes[b],{toast_check_mode:"official",mode_reason:"ok",mode_checked_at:new Date().toISOString()});
  return {data:true,error:null};
 },from(table:string){let b="",patch:object|null=null;
  const q={select(){return q;},eq(k:string,v:string){if(k==="business_id")b=v;return q;},is(){return q;},update(p:object){patch=p;return q;},
   async single(){return {data:modes[b],error:null};},async maybeSingle(){return {data:analytics[b]??null,error:null};},
   then(ok:(v:unknown)=>unknown){const row=table==="toast_api_credentials"?modes[b]:table==="toast_analytics_credentials"?analytics[b]:{};
    if(row&&patch)Object.assign(row,patch);return Promise.resolve({data:null,error:null}).then(ok);}};return q;}};
 return {db:db as unknown as SupabaseClient,modes,analytics};
}
beforeEach(()=>{probe.mockReset();});
it("no Analytics credentials never probes ERA with Standard credentials",async()=>{
 const f=fixture();delete f.analytics.A;
 expect(await detectToastCheckMode(f.db,"A","g","UTC",Date.now()+10000)).toBe("internal");
 expect(probe).not.toHaveBeenCalled();expect(f.modes.A.mode_reason).toBe("no_analytics_credentials");
});
it("a café's forbidden probe changes only its own mode and verification",async()=>{
 const f=fixture();probe.mockRejectedValue(new ToastApiError("missing_permissions"));
 await expect(detectToastCheckMode(f.db,"A","g","UTC",Date.now()+10000,true)).rejects.toMatchObject({category:"missing_permissions"});
 expect(f.modes.A).toMatchObject({toast_check_mode:"internal",mode_reason:"analytics_forbidden"});
 expect(f.modes.B.toast_check_mode).toBe("official");expect(f.analytics.B.verified_at).toBe("before");
});
it("a successful real probe selects official mode and a recent mode skips the weekly probe",async()=>{
 const f=fixture();probe.mockImplementation(async()=>{f.analytics.A.verified_at="verified";return true;});
 expect(await detectToastCheckMode(f.db,"A","g","UTC",Date.now()+10000)).toBe("official");
 expect(f.modes.A.mode_reason).toBe("ok");
 expect(await detectToastCheckMode(f.db,"B","g","UTC",Date.now()+10000)).toBe("official");
 expect(probe).toHaveBeenCalledTimes(1);
});

it("does not promote official mode if credentials disappear after an ERA probe",async()=>{
 const f=fixture();probe.mockResolvedValue(true);
 await expect(detectToastCheckMode(f.db,"A","g","UTC",Date.now()+10000,true))
  .rejects.toMatchObject({category:"unavailable"});
 expect(f.modes.A.toast_check_mode).toBe("internal");
});
