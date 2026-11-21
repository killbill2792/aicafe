import {describe,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createOwnerScopedCafeTools} from "./cafeTools.server";

describe("U1 registered owner-scope coverage reader",()=>{
 const scope={businessId:"fixture-cafe",ownerUserId:"fixture-owner"};
 it("uses the explicit owner-bound RPC in unattended turns and returns only permission booleans",async()=>{
  const rpc=vi.fn(async()=>({data:{menus:true,labor:false,privateCredential:"must not escape"},error:null}));
  const tools=createOwnerScopedCafeTools(scope,{rpc} as unknown as SupabaseClient);
  expect(await tools.getToastScopeCoverage()).toEqual({available:true,value:{menus:true,labor:false},
   quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}});
  expect(rpc).toHaveBeenCalledExactlyOnceWith("toast_business_scope_summary",{p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId});
 });
 it("retains the existing owner-session RPC and never impersonates it for a failed worker read",async()=>{
  const browserRpc=vi.fn(async()=>({data:{menus:null,labor:null},error:null}));
  const browser=createOwnerScopedCafeTools(scope,{rpc:browserRpc} as unknown as SupabaseClient,true);
  expect((await browser.getToastScopeCoverage()).value).toEqual({menus:null,labor:null});
  expect(browserRpc).toHaveBeenCalledExactlyOnceWith("toast_business_scope_summary",{p_business_id:scope.businessId});
  const error={code:"42501",message:"unauthorized"};
  const rpc=vi.fn(async()=>({data:null,error}));
  const worker=createOwnerScopedCafeTools(scope,{rpc} as unknown as SupabaseClient);
  await expect(worker.getToastScopeCoverage()).rejects.toEqual(error);
  expect(rpc).toHaveBeenCalledOnce();
 });
});
