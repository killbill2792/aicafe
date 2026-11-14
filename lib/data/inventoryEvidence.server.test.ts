import {describe,it,expect,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const db=vi.hoisted(()=>({
 user:vi.fn(),membership:vi.fn(),business:vi.fn(),read:vi.fn()
}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:async()=>({
 auth:{getUser:db.user},
 from:()=>({select:()=>({eq:()=>({eq:()=>({maybeSingle:db.membership})})})})
})}));
vi.mock("@/lib/data/getActiveBusinessId",()=>({getActiveBusinessId:db.business}));
vi.mock("@/lib/data/canonical/reads.server",()=>({readCanonicalView:db.read}));
import {readInventoryEvidence} from "./inventoryEvidence.server";
const owner="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const cafe="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
describe("Pantry shared canonical stock reader",()=>{
 beforeEach(()=>{
  vi.resetAllMocks();
  db.user.mockResolvedValue({data:{user:{id:owner}}});
  db.business.mockResolvedValue(cafe);
  db.membership.mockResolvedValue({data:{role:"owner"},error:null});
  db.read.mockResolvedValue({rows:[{source:"toast",source_ref:"toast-current:item",status:"open",
   business_date:"2026-11-12",stock_status:"QUANTITY",quantity:5,
   data:{evidence_state:"not_observed",source_as_of:"2026-11-10T14:00:00Z"}}],
   notes:[],truncated:false,error:undefined});
 });
 it("uses only the authenticated business and the existing invoker-RLS view",async()=>{
  const result=await readInventoryEvidence("2026-11-12");
  expect(db.business).toHaveBeenCalledWith(owner);
  expect(db.read).toHaveBeenCalledWith(expect.anything(),cafe,
   "cv_inventory",{dateFrom:"2026-11-12",dateTo:"2026-11-12"},100);
  expect(result.rows[0].quantity).toBeNull();
  expect(result.rows[0].evidence_state).toBe("not_observed");
 });
 it("rejects missing owner membership before data access",async()=>{
  db.membership.mockResolvedValue({data:{role:"staff"},error:null});
  await expect(readInventoryEvidence("2026-11-12")).rejects.toThrow("owner_required");
  expect(db.read).not.toHaveBeenCalled();
 });
 it("fails closed on absent source without claiming empty stock",async()=>{
  db.read.mockResolvedValue({rows:[],notes:["source_read_failed"],
   empty:true,truncated:false,error:"source_read_failed"});
  await expect(readInventoryEvidence("2026-11-12")).rejects.toThrow("inventory_reader_unavailable");
 });
 it("rejects arbitrary dates without accessing any café",async()=>{
  await expect(readInventoryEvidence("tomorrow")).rejects.toThrow("inventory_invalid_date");
  expect(db.business).not.toHaveBeenCalled();
 });
});
