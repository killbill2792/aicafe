import {beforeEach,describe,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({
 memberRole:"owner",isDemo:false,otherOwner:false,deleteFailure:false,
 deletedCafes:[] as string[],deletedUsers:[] as string[],
}));
vi.mock("@/lib/supabase/client",()=>({isSupabaseConfigured:()=>true}));
vi.mock("@/lib/security/tokenCrypto",()=>({decryptToken:()=>""}));
vi.mock("@/lib/pos/square/oauth",()=>({squareApiBaseUrl:()=>"https://example.invalid"}));
vi.mock("@/lib/constants",()=>({DEMO_BUSINESS_ID:"00000000-0000-4000-8000-000000000000"}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:async()=>({
 auth:{getUser:async()=>({data:{user:{id:"user-one"}}})},
 from:()=>({select:()=>({eq:async()=>({data:[{
   business_id:"cafe-one",role:state.memberRole,businesses:{is_demo:state.isDemo}
 }],error:null})})})
})}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({
 auth:{admin:{deleteUser:async(id:string)=>{state.deletedUsers.push(id);return {error:null};}}},
 storage:{from:()=>({list:async()=>({data:[]}),remove:async()=>({error:null})})},
 from:(table:string)=>{
  const chain={
   select:()=>chain,eq:()=>chain,neq:()=>chain,
   limit:async()=>({data:state.otherOwner?[{user_id:"other-owner"}]:[],error:null}),
   maybeSingle:async()=>({data:null,error:null}),
   delete:()=>chain,
   then:(resolve:(v:unknown)=>unknown)=>Promise.resolve({error:state.deleteFailure?
     {code:"FK_BLOCKED"}:null}).then(resolve),
  };
  if(table==="businesses"){
   return {...chain,delete:()=>({eq:async(_field:string,id:string)=>{
     state.deletedCafes.push(id);
     return {error:state.deleteFailure?{code:"FK_BLOCKED"}:null};
   }})};
  }
  return chain;
 },
})}));
import {deleteAccount} from "./deleteAccount";
beforeEach(()=>{
 state.memberRole="owner";state.isDemo=false;state.otherOwner=false;
 state.deleteFailure=false;state.deletedCafes=[];state.deletedUsers=[];
});
describe("account deletion cannot erase another user's café",()=>{
 it("never deletes a café for a non-owner staff member",async()=>{
  state.memberRole="staff";
  expect(await deleteAccount()).toEqual({ok:true});
  expect(state.deletedCafes).toEqual([]);
  expect(state.deletedUsers).toEqual(["user-one"]);
 });
 it("preserves shared cafés owned by another account",async()=>{
  state.otherOwner=true;
  expect(await deleteAccount()).toEqual({ok:true});
  expect(state.deletedCafes).toEqual([]);
  expect(state.deletedUsers).toEqual(["user-one"]);
 });
 it("deletes only a sole-owner café before its account",async()=>{
  expect(await deleteAccount()).toEqual({ok:true});
  expect(state.deletedCafes).toEqual(["cafe-one"]);
  expect(state.deletedUsers).toEqual(["user-one"]);
 });
 it("never deletes the account if business deletion fails",async()=>{
  state.deleteFailure=true;
  const result=await deleteAccount();
  expect(result.ok).toBe(false);
  expect(state.deletedUsers).toEqual([]);
 });
});
