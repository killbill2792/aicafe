import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {recordOwnerSupplierOutcome,explicitOwnerSupplierOutcome,explicitOwnerSupplierChannel,authenticatedSupplierOwnerTurn} from "./ownerSupplierOutcome.server";
import type {SupabaseClient} from "@supabase/supabase-js";

const scope={businessId:"11111111-1111-4111-8111-111111111111",
 ownerUserId:"22222222-2222-4222-8222-222222222222"};
const input={purchaseOrderId:"33333333-3333-4333-8333-333333333333",
 channel:"phone" as const,outcome:"supplier_accepted" as const,
 note:"The supplier accepted this PO by phone."};
function fixture(options?:{order?:boolean;terminal?:Record<string,string>;error?:string}){
 const insert=vi.fn();
 const from=vi.fn((table:string)=>{
  const chain={
   select:vi.fn(()=>chain),eq:vi.fn(()=>chain),in:vi.fn(()=>chain),
   order:vi.fn(()=>chain),
   maybeSingle:vi.fn(async()=>({data:options?.order===false?null:
      {id:input.purchaseOrderId,status:"approved_for_ordering"},
     error:options?.error==="order"?{message:"db"}:null})),
   limit:vi.fn(async()=>({data:options?.terminal?[options.terminal]:[],
     error:options?.error==="reports"?{message:"db"}:null})),
   insert:vi.fn((payload:unknown)=>{insert(payload);return chain}),
   single:vi.fn(async()=>({data:{id:"44444444-4444-4444-8444-444444444444",
     reported_at:"2026-11-18T17:00:00Z"},error:null}))
  };
  if(table==="purchase_order_channel_reports")return chain;
  if(table==="purchase_orders")return chain;
  throw new Error("unexpected table "+table);
 });
 return {db:{from} as unknown as SupabaseClient,from,insert};
}

describe("Task14C owner-reported outcome authority",()=>{
 beforeEach(()=>vi.clearAllMocks());
 it("accepts a real job-backed authenticated owner turn, but not a different job or model text",()=>{
  const owner={id:"99999999-9999-4999-8999-999999999999",role:"owner",
    text:"The supplier accepted the PO by phone."};
  const threadId="88888888-8888-4888-8888-888888888888";
  const job={ownerMessageId:owner.id,threadId,status:"running"};
  const verified={owner,ownerText:owner.text,threadId,job};
  expect(authenticatedSupplierOwnerTurn(verified)).toBe(true);
  expect(authenticatedSupplierOwnerTurn({...verified,job:null})).toBe(true);
  expect(authenticatedSupplierOwnerTurn({...verified,job:{...job,ownerMessageId:input.purchaseOrderId}})).toBe(false);
  expect(authenticatedSupplierOwnerTurn({...verified,job:{...job,threadId:input.purchaseOrderId}})).toBe(false);
  expect(authenticatedSupplierOwnerTurn({...verified,job:{...job,status:"failed"}})).toBe(false);
  expect(authenticatedSupplierOwnerTurn({...verified,ownerText:"The supplier accepted a different PO."})).toBe(false);
  expect(authenticatedSupplierOwnerTurn({...verified,owner:{...owner,role:"supervisor"}})).toBe(false);
 });
 it("writes exactly one canonical owner-scoped report and labels it owner-reported, never Gmail verified",async()=>{
  const f=fixture();
  const report=await recordOwnerSupplierOutcome(f.db,scope,input);
  expect(report).toMatchObject({alreadyRecorded:false,outcome:"supplier_accepted",
    providerVerified:false,source:"owner_reported"});
  expect(f.insert).toHaveBeenCalledOnce();
  expect(f.insert).toHaveBeenCalledWith(expect.objectContaining({
    business_id:scope.businessId,owner_user_id:scope.ownerUserId,
    purchase_order_id:input.purchaseOrderId,channel:"phone",outcome:"supplier_accepted",
    note:input.note}));
 });
 it("refuses a foreign or absent PO without creating a report",async()=>{
  const f=fixture({order:false});
  await expect(recordOwnerSupplierOutcome(f.db,scope,input))
    .rejects.toThrow("supplier_order_not_found");
  expect(f.insert).not.toHaveBeenCalled();
 });
 it("treats a repeated identical terminal report as idempotent",async()=>{
  const prior={id:"55555555-5555-4555-8555-555555555555",
    reported_at:"2026-11-18T15:00:00Z",
    outcome:input.outcome,channel:input.channel,note:input.note};
  const f=fixture({terminal:prior});
  const report=await recordOwnerSupplierOutcome(f.db,scope,input);
  expect(report.reportId).toBe(prior.id);
  expect(report.alreadyRecorded).toBe(true);
  expect(f.insert).not.toHaveBeenCalled();
 });
 it("never lets another model turn reverse a terminal supplier outcome",async()=>{
  const f=fixture({terminal:{id:"abc",reported_at:"2026-11-18T15:00:00Z",
    outcome:"supplier_declined",channel:"phone",note:"The supplier declined."}});
  await expect(recordOwnerSupplierOutcome(f.db,scope,input))
    .rejects.toThrow("supplier_terminal_report_requires_owner_review");
  expect(f.insert).not.toHaveBeenCalled();
 });
 it("rejects unsupported/negated owner statements instead of inferring supplier acceptance",()=>{
  expect(explicitOwnerSupplierOutcome("The supplier accepted this PO by phone.","supplier_accepted")).toBe(true);
  expect(explicitOwnerSupplierOutcome("The supplier did not accept this PO.","supplier_accepted")).toBe(false);
  expect(explicitOwnerSupplierOutcome("The supplier hasn’t accepted this PO by phone.","supplier_accepted")).toBe(false);
  expect(explicitOwnerSupplierOutcome("The supplier hasn't accepted this PO by phone.","supplier_accepted")).toBe(false);
  expect(explicitOwnerSupplierOutcome("The supplier may have accepted this PO by phone.","supplier_accepted")).toBe(false);
  expect(explicitOwnerSupplierOutcome("The supplier hasn’t declined this PO by phone.","supplier_declined")).toBe(false);
  expect(explicitOwnerSupplierOutcome("Gmail says SENT.","supplier_accepted")).toBe(false);
  expect(explicitOwnerSupplierOutcome("The supplier declined this PO.","supplier_declined")).toBe(true);
  expect(explicitOwnerSupplierChannel("The supplier accepted by phone.","phone")).toBe(true);
  expect(explicitOwnerSupplierChannel("The supplier accepted by phone.","gmail")).toBe(false);
  expect(explicitOwnerSupplierChannel("Accepted through the portal.","portal")).toBe(true);
 });
});
