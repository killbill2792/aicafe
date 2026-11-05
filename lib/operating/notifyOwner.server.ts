import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";

/** The producer supplies the owner-approved policy; this layer never edits consent
 * or transport state. A missing policy preserves existing in-app delivery. */
export type OwnerNoticePolicy={
  mutedKinds?:readonly string[];
  dailyCap?:number;
  allowedChannels?:readonly ("in_app"|"whatsapp")[];
};
export type OwnerNoticeRequest={
  businessId:string;
  ownerUserId:string;
  threadId:string;
  taskId:string;
  kind:string;
  /** The café-local date, not the server's UTC date. Required for a daily cap. */
  localDate?:string;
  important:boolean;
  /** Required scheduled reports (e.g. the morning brief) bypass optional muting/caps. */
  required?:boolean;
  policy?:OwnerNoticePolicy;
};
export type OwnerNoticeResult<T>={
  decision:"posted"|"ignored"|"muted"|"capped"|"channel_blocked";
  threadId:string;
  result:T|null;
  channels:{inApp:"posted"|"skipped";whatsapp:"not_delivered"};
};
type Db=Pick<SupabaseClient,"from">;

const skipped=<T>(decision:Exclude<OwnerNoticeResult<T>["decision"],"posted">,threadId:string):
  OwnerNoticeResult<T>=>({
    decision,threadId,result:null,channels:{inApp:"skipped",whatsapp:"not_delivered"},
  });

/** One decision for owner-facing inbox + chat notices. The existing writer
 * callback keeps its idempotent task/message IDs and its partial-write repair.
 * WhatsApp is only delivered by the existing consent-aware queue: success here
 * NEVER means a WhatsApp send was successful. */
export async function notifyOwner<T>(db:Db,notice:OwnerNoticeRequest,
  write:()=>Promise<T>):Promise<OwnerNoticeResult<T>>{
  if(!notice.businessId||!notice.ownerUserId||!notice.threadId||
    !notice.taskId||!notice.kind)throw new Error("Owner notice scope is incomplete");
  if(!notice.important)return skipped("ignored",notice.threadId);
  if(!notice.required){
    if(notice.policy?.mutedKinds?.includes(notice.kind))
      return skipped("muted",notice.threadId);
    if(notice.policy?.allowedChannels &&
      !notice.policy.allowedChannels.includes("in_app"))
      return skipped("channel_blocked",notice.threadId);
    const cap=notice.policy?.dailyCap;
    if(cap!==undefined){
      if(!Number.isSafeInteger(cap)||cap<0)throw new Error("Invalid owner notice daily cap");
      if(!notice.localDate||!/^\d{4}-\d{2}-\d{2}$/u.test(notice.localDate))
        throw new Error("Owner notice needs a café-local date for the cap");
      // A previous task may have committed while its chat message failed. It
      // must be repaired even when today's quota is now full.
      const existing=await db.from("operating_tasks").select("id")
        .eq("business_id",notice.businessId).eq("id",notice.taskId).maybeSingle();
      if(existing.error)throw existing.error;
      if(!existing.data){
        const quota=await db.from("operating_tasks").select("id",{head:true,count:"exact"})
          .eq("business_id",notice.businessId)
          .contains("payload",{ownerNoticeDate:notice.localDate});
        if(quota.error)throw quota.error;
        if((quota.count??0)>=cap)return skipped("capped",notice.threadId);
      }
    }
  }
  const result=await write();
  return {decision:"posted",threadId:notice.threadId,result,
    channels:{inApp:"posted",whatsapp:"not_delivered"}};
}
