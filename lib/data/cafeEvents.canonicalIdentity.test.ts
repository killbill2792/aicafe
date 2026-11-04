import {describe,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";

vi.mock("server-only",()=>({}));
vi.mock("./cafeLocation.server",()=>({
  readPrimaryLocation:vi.fn(async()=>({city:"San Francisco",region:"CA",country_code:"US"})),
}));
import {readCanonicalCafeEvents} from "./cafeEvents.server";

function row(id:string,venue:string,address:string){
  return {id,name:"Community Open Day",kind:"community",
    start_date:"2026-11-13",end_date:"2026-11-13",
    start_time:null,end_time:null,venue,venue_address:address,area_label:null,
    source_url:"https://events.example.org/"+id,status:"found",
    found_at:"2026-11-01T00:00:00Z",last_checked_at:"2026-11-02T00:00:00Z",
    last_verification_attempt_at:null,last_verified_at:null,
    verification_failed_at:null,verification_details:null};
}

describe("canonical café events keep identities for monitoring",()=>{
  it("never hides same-day different venues or distant events from verification",async()=>{
    const rows=[
      row("central","Central Hall","1 Main St, San Francisco, CA, US"),
      row("west","West Hall","2 Main St, San Francisco, CA, US"),
      row("remote","Eastern Hall","1 Road, Portland, OR, US"),
    ];
    const db={from(table:string){
      const q={
        select:()=>q,eq:()=>q,in:()=>q,lte:()=>q,gte:()=>q,order:()=>q,
        range:async()=>({data:[],error:null}),
        limit:async()=>({data:table==="cafe_events"?rows:[],error:null}),
      };
      return q;
    }} as unknown as SupabaseClient;
    const canonical=await readCanonicalCafeEvents(db,"cafe-a","2026-11-03","2026-11-16");
    expect(canonical.map(e=>e.id)).toEqual(["central","west","remote"]);
    expect(canonical.map(e=>e.venue)).toEqual(["Central Hall","West Hall","Eastern Hall"]);
  });
});
