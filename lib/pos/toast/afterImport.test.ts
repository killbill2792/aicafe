import {describe,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
import {afterToastImport} from "./afterImport";
const business="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
describe("guarded B-owned derived refresh loader",()=>{
 it("passes authenticated business and timezone to one shared B refresh",async()=>{
  const db={} as SupabaseClient,run=vi.fn(async()=>{});
  const result=await afterToastImport(db,business,"America/Los_Angeles",
   async()=>({refreshDerivedForBusiness:run}));
  expect(run).toHaveBeenCalledExactlyOnceWith(db,business,"America/Los_Angeles");
  expect(result).toEqual({derivedRefreshPending:false,derivedRefreshNote:null});
 });
 it("missing B module or failed refresh records a note but never throws",async()=>{
  const spy=vi.spyOn(console,"warn").mockImplementation(()=>{});
  try{
   for(const load of [
    async()=>{throw new Error("module absent");},
    async()=>({refreshDerivedForBusiness:async()=>{throw new Error("failed");}})
   ]){
    const result=await afterToastImport({} as SupabaseClient,business,"UTC",load);
    expect(result).toEqual({derivedRefreshPending:true,derivedRefreshNote:"derived_refresh_unavailable"});
   }
   expect(spy).toHaveBeenCalledTimes(2);
  }finally{spy.mockRestore();}
 });
});
