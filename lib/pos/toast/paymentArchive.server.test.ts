import type {SupabaseClient} from "@supabase/supabase-js";
import {expect,it,vi} from "vitest";
import {toastPaymentArchive} from "./paymentArchive.server";
import type {createToastClient} from "./client";

vi.mock("server-only",()=>({}));

const location={businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  restaurantGuid:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"};
const guid="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const another="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
function fixture(){
  const checkpoint={select:()=>checkpoint,eq:()=>checkpoint,
    maybeSingle:async()=>({data:{revision:8},error:null})};
  const rpc=vi.fn().mockResolvedValue({data:9,error:null});
  const request=vi.fn();
  const authorize=vi.fn().mockResolvedValue("grant-before");
  const db={rpc,from:()=>checkpoint} as unknown as SupabaseClient;
  const client={request,assertSourceAccess:authorize} as unknown as ReturnType<typeof createToastClient>;
  return {payments:toastPaymentArchive(db,location,client),rpc,request,authorize};
}

it("retains independent payment dates and unknown data while scrubbing card fields at the response root",async()=>{
  const {payments,rpc,request}=fixture();
  request.mockResolvedValue({guid,orderGuid:another,paidBusinessDate:20261023,
    refund:{refundBusinessDate:20261025,refundAmount:2},voidInfo:null,originalProcessingFee:0,
    cardType:"VISA",first6Digits:"411111",last4Digits:"1111",extra:{opaque:[null,"observed"]}});
  await expect(payments.detail(guid)).resolves.toMatchObject({externalRevision:9,value:{guid,originalProcessingFee:0}});
  expect(rpc).toHaveBeenCalledWith("external_commit_page",expect.objectContaining({
    p_account:location.restaurantGuid,p_resource:"orders/v2/payments/{guid}",p_stream:guid,p_revision:8,
    p_next:{cursor:null,scope:{paymentGuid:guid},mode:"point"},p_complete:true,
    p_records:[expect.objectContaining({key:guid,payload:{guid,orderGuid:another,paidBusinessDate:20261023,
      refund:{refundBusinessDate:20261025,refundAmount:2},voidInfo:null,originalProcessingFee:0,
      cardType:"VISA",extra:{opaque:[null,"observed"]}}})],
  }));
});

it("uses the exact stored paid-date receipt until it is replaced",async()=>{
  const {payments,rpc,request}=fixture();
  rpc.mockResolvedValueOnce({data:[{payload:[guid]}],error:null})
    .mockResolvedValueOnce({data:null,error:{code:"40001"}});
  const day="2026-10-23";
  await expect(payments.list(day,"paidBusinessDate",20000,undefined,7))
    .resolves.toEqual({value:[guid],externalRevision:7});
  expect(request).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledWith("external_read_observation",expect.objectContaining({
    p_stream:"paidBusinessDate:"+day,p_scope:{businessDate:day,dateField:"paidBusinessDate"},
    p_mode:"window",p_revision:7,
  }));
  request.mockResolvedValueOnce([another]);
  await expect(payments.list(day,"paidBusinessDate",20000,undefined,7))
    .resolves.toEqual({value:[another],externalRevision:9});
  expect(request).toHaveBeenCalledWith("/orders/v2/payments?paidBusinessDate=20261023",
    location.restaurantGuid,expect.anything(),expect.anything());
});

it("commits neither an unrelated payment nor data received under a replaced grant",async()=>{
  const {payments,rpc,request,authorize}=fixture();
  request.mockResolvedValueOnce({guid:another}).mockResolvedValueOnce({guid});
  await expect(payments.detail(guid)).rejects.toMatchObject({category:"invalid_response"});
  expect(rpc).not.toHaveBeenCalled();
  authorize.mockResolvedValueOnce("grant-before").mockResolvedValueOnce("grant-after");
  await expect(payments.detail(guid)).rejects.toThrow("External source access changed");
  expect(rpc).not.toHaveBeenCalledWith("external_commit_page",expect.anything());
  for(const resource of ["orders/v2/payments","orders/v2/payments/{guid}"]){
    expect(rpc).toHaveBeenCalledWith("external_note_availability",expect.objectContaining({
      p_resource:resource,p_account:location.restaurantGuid,p_status:"permission_required",
    }));
  }
});
