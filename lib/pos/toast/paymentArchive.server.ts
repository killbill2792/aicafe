import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {z} from "zod";
import {openSourceStream,type SourceRecord} from "@/lib/externalData/archive.server";
import {readWithSourceAccess} from "@/lib/externalData/pages";
import {createToastClient,GUID,ToastApiError} from "./client";

type Location={businessId:string;restaurantGuid:string};
type DateField="paidBusinessDate"|"refundBusinessDate"|"voidBusinessDate";
const path="/orders/v2/payments";
const detailResource=path.slice(1)+"/{guid}";
const paymentSchema=z.looseObject({
  guid:GUID,orderGuid:GUID.nullish(),paidBusinessDate:z.number().int().nullish(),
  type:z.string().nullish(),paymentStatus:z.string().nullish(),amount:z.number().finite().nullish(),
  originalProcessingFee:z.number().finite().nullish(),restaurantGuid:GUID.nullish(),
});
const idsSchema=z.array(GUID);
export const paymentReceiptSchema=z.object({externalRevision:z.number().int().positive()}).strict();
const feeResult=z.enum(["applied","order_pending","refresh_evidence"]);

function replacedObservation(error:unknown) {
  return error!=null&&typeof error==="object"&&"code" in error&&
    (error.code==="40001"||error.code==="55000");
}

/** Reuse the caller's recovery and request budget. A dated list describes
 * membership only; a single payment never certifies coverage of a date. */
export function toastPaymentArchive(db:SupabaseClient,location:Location,
  client=createToastClient(db,location.businessId)) {
  const {businessId,restaurantGuid}=location;
  const source={businessId,provider:"toast",account:restaurantGuid};
  const authorize=()=>client.assertSourceAccess(restaurantGuid,"orders");
  async function readReceipt<T>(stream:Awaited<ReturnType<typeof openSourceStream>>,
    scope:Record<string,string>,mode:"window"|"point",schema:z.ZodType<T>,revision:number) {
    try{
      const records=await readWithSourceAccess(authorize,()=>stream.completedRecords(scope,mode,revision));
      if(records.length!==1)throw new ToastApiError("unavailable");
      return schema.parse(records[0]);
    }catch(error){
      if(!replacedObservation(error))throw error;
      return null;
    }
  }
  async function capture<T>(
    resource:string,key:string,scope:Record<string,string>,mode:"window"|"point",
    schema:z.ZodType<T>,request:()=>Promise<T>,revision?:number,
    record:(value:T)=>Omit<SourceRecord,"key">=payload=>({payload}),
  ) {
    const stream=await openSourceStream(db,source,resource,key);
    if(revision!==undefined){
      const value=await readReceipt(stream,scope,mode,schema,revision);
      if(value!==null)return {value,externalRevision:revision};
      // Keep reconciliation on the same provider scope when its receipt was replaced.
    }
    const value=await readWithSourceAccess(authorize,request);
    const externalRevision=await stream.commit([{key,...record(value)}],{cursor:null,scope,mode},true);
    return {value,externalRevision};
  }
  return {
    list(day:string,field:DateField,limit=20000,deadlineAt?:number,revision?:number) {
      const scope={businessDate:day,dateField:field};
      const schema=idsSchema.max(limit);
      return capture(path.slice(1),field+":"+day,scope,"window",schema,async()=>{
        let continuation:string|null=null;
        const ids=await client.request(path+"?"+field+"="+z.iso.date().parse(day).replaceAll("-",""),
          restaurantGuid,idsSchema,{deadlineAt,onResponse:({nextPageToken})=>{continuation=nextPageToken;}});
        if(continuation)throw new ToastApiError("invalid_response");
        if(ids.length>limit)throw new ToastApiError(limit===20000?"too_many_payments":"invalid_response");
        return ids;
      },revision);
    },
    detail(guid:string,deadlineAt?:number,revision?:number) {
      const key=GUID.parse(guid).toLowerCase();
      return capture(detailResource,key,{paymentGuid:key},"point",paymentSchema,async()=>{
        const payment=await client.request(path+"/"+key,restaurantGuid,paymentSchema,{deadlineAt});
        if(payment.guid.toLowerCase()!==key||
          (payment.restaurantGuid&&payment.restaurantGuid.toLowerCase()!==restaurantGuid.toLowerCase())){
          throw new ToastApiError("invalid_response");
        }
        return payment;
      },revision,payload=>({payload,payloadKind:"payment"}));
    },
    async applyFeeReceipt(guid:string,revision:number) {
      await authorize();
      const {data,error}=await db.rpc("toast_apply_archived_payment_fee",{
        p_business_id:businessId,p_restaurant_guid:restaurantGuid,p_payment_guid:guid,p_revision:revision,
      });
      if(error)throw new ToastApiError("unavailable");
      return feeResult.parse(data);
    },
  };
}
