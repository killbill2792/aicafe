import {beforeEach,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
const probe=vi.hoisted(()=>vi.fn());
vi.mock("./analyticsClient",()=>({createToastAnalyticsClient:(_db:unknown,b:string)=>({test:(...args:unknown[])=>probe(b,...args)})}));
import {detectToastCheckMode,setToastCheckMode} from "./checkMode";
import {ToastApiError} from "./client";
function fixture(){
 const modes:Record<string,Record<string,unknown>>={
  A:{toast_check_mode:"internal",mode_checked_at:null},
  B:{toast_check_mode:"official",mode_checked_at:new Date().toISOString()}
 };
 const analytics:Record<string,Record<string,unknown>>={
  A:{business_id:"A",verified_at:null},B:{business_id:"B",verified_at:"before"}
 };
 type Day={business_id:string;restaurant_guid:string;business_date:string;
  import_state:string;rechecking_reason:string|null;recon_state:string;
  analytics_state:string|null;last_recon_attempt_at:string|null;last_error_category:string|null};
 type Job={business_id:string;restaurant_guid:string;business_date:string;
  state:string;requested_at:string};
 const days:Day[]=[],jobs:Job[]=[];
 const db={
  async rpc(name:string,args:{p_business_id:string}){
   if(name!=="toast_enable_official_check")throw Error("unexpected RPC");
   const b=args.p_business_id;
   if(!analytics[b]?.verified_at)return {data:false,error:null};
   const wasInternal=modes[b].toast_check_mode==="internal";
   Object.assign(modes[b],{toast_check_mode:"official",mode_reason:"ok",
    mode_checked_at:new Date().toISOString()});
   const eligible=days.filter(d=>d.business_id===b&&d.import_state==="imported"&&!d.rechecking_reason);
   for(let i=jobs.length-1;i>=0;i--){
    const j=jobs[i],d=eligible.find(x=>x.restaurant_guid===j.restaurant_guid&&
     x.business_date===j.business_date);
    if(d&&(d.analytics_state==="missing"||wasInternal&&d.analytics_state==="pending"))
     jobs.splice(i,1);
   }
   for(const d of eligible){
    if(d.analytics_state==="missing"||
     d.recon_state==="checked_internal"&&d.analytics_state===null||
     wasInternal&&d.analytics_state==="pending"){
     d.analytics_state="pending";d.last_recon_attempt_at=null;
     if(["authentication","missing_permissions","analytics_timeout"].includes(d.last_error_category??""))
      d.last_error_category=null;
    }
   }
   return {data:true,error:null};
  },
  from(table:string){
   let b="",patch:Record<string,unknown>|null=null;
   const q={
    select(){return q;},
    eq(k:string,v:string){if(k==="business_id")b=v;return q;},
    is(){return q;},
    update(p:Record<string,unknown>){patch=p;return q;},
    async single(){return {data:modes[b],error:null};},
    async maybeSingle(){return {data:analytics[b]??null,error:null};},
    then(ok:(v:unknown)=>unknown){
     const row=table==="toast_api_credentials"?modes[b]:table==="toast_analytics_credentials"?analytics[b]:{};
     if(row&&patch)Object.assign(row,patch);
     return Promise.resolve({data:null,error:null}).then(ok);
    }
   };
   return q;
  }
 };
 return {db:db as unknown as SupabaseClient,modes,analytics,days,jobs};
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

it("restores suspended reports across restaurants without changing other cafés",async()=>{
 const f=fixture();f.analytics.A.verified_at="reverified";
 const old=new Date(Date.now()-72*3600000).toISOString();
 for(const [restaurant,business,date,state,error] of [
  ["r1","A","2026-10-01","missing","authentication"],
  ["r2","A","2026-10-02","pending","rate_limited"],
  ["r3","A","2026-10-03","available",null],
  ["r4","B","2026-10-01","missing","authentication"]
 ] as const){
  f.days.push({business_id:business,restaurant_guid:restaurant,business_date:date,
   import_state:"imported",rechecking_reason:null,recon_state:"mismatch",
   analytics_state:state,last_recon_attempt_at:old,last_error_category:error});
  f.jobs.push({business_id:business,restaurant_guid:restaurant,business_date:date,
   state:state==="available"?"available":"pending",requested_at:old});
 }
 await setToastCheckMode(f.db,"A","official","ok");
 expect(f.jobs.map(j=>j.restaurant_guid).sort()).toEqual(["r3","r4"]);
 expect(f.days.map(d=>d.analytics_state)).toEqual(["pending","pending","available","missing"]);
 expect(f.days[0].last_recon_attempt_at).toBeNull();
 expect(f.days[1].last_recon_attempt_at).toBeNull();
 expect(f.days[0].last_error_category).toBeNull();
 expect(f.days[1].last_error_category).toBe("rate_limited");
 expect(f.modes.B.toast_check_mode).toBe("official");
});
it("a routine official probe does not restart a healthy pending report",async()=>{
 const f=fixture();f.analytics.A.verified_at="reverified";
 f.modes.A.toast_check_mode="official";
 f.days.push({business_id:"A",restaurant_guid:"r1",business_date:"2026-10-01",
  import_state:"imported",rechecking_reason:null,recon_state:"checked_internal",
  analytics_state:"pending",last_recon_attempt_at:"2026-10-20T12:00:00Z",
  last_error_category:null});
 f.jobs.push({business_id:"A",restaurant_guid:"r1",business_date:"2026-10-01",
  state:"pending",requested_at:"2026-10-20T12:00:00Z"});
 await setToastCheckMode(f.db,"A","official","ok");
 expect(f.jobs).toHaveLength(1);
 expect(f.days[0].last_recon_attempt_at).toBe("2026-10-20T12:00:00Z");
});
