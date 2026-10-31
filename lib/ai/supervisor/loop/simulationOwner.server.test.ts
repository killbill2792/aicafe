import {describe,expect,it,vi} from "vitest";
const auth=vi.hoisted(()=>({session:vi.fn(),active:vi.fn()}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:auth.session}));
vi.mock("@/lib/data/getActiveBusinessId",()=>({getActiveBusinessId:auth.active}));
import {simulationOwnerReader} from "./simulationOwner.server";
const scope={businessId:"11111111-1111-4111-8111-111111111111",
 ownerUserId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
 threadId:"22222222-2222-4222-8222-222222222222",locale:"en" as const};
function clientFor(role:string,cafeId=scope.businessId,demo=false){
 const from=vi.fn((table:string)=>{
   const query={
     select:()=>query,eq:()=>query,maybeSingle:async()=>({error:null,
       data:table==="memberships"?{role,business_id:cafeId,user_id:scope.ownerUserId}: {is_demo:demo}}),
   };
   return query;
 });
 return {from,auth:{getUser:vi.fn(()=>{throw new Error("cookie lookup is forbidden for a WhatsApp read");})}};
}
describe("shared inert proposal simulation authorization",()=>{
 it("uses the explicitly authorized owner/café client and never a website session",async()=>{
   auth.session.mockClear();
   const db=clientFor("owner");
   const result=await simulationOwnerReader({...scope,verifiedReadClient:db as never});
   expect(result.explicit).toBe(true);
   expect(result.client).toBe(db);
   expect(db.auth.getUser).not.toHaveBeenCalled();
   expect(auth.session).not.toHaveBeenCalled();
   expect(db.from).toHaveBeenCalledWith("memberships");
   expect(db.from).toHaveBeenCalledWith("businesses");
 });
 it("rejects a cross-café member or non-owner even with a service client",async()=>{
   const other=clientFor("member");
   await expect(simulationOwnerReader({...scope,verifiedReadClient:other as never}))
     .rejects.toMatchObject({code:"unauthorized"});
   const demo=clientFor("owner",scope.businessId,true);
   await expect(simulationOwnerReader({...scope,verifiedReadClient:demo as never}))
     .rejects.toMatchObject({code:"unauthorized"});
 });
});
