import "server-only";
import {createHmac,timingSafeEqual} from "node:crypto";
import {z} from "zod";
export const toastEventSchema=z.object({
  guid:z.uuid(),timestamp:z.iso.datetime({offset:true}),eventCategory:z.string(),
  eventType:z.string(),details:z.object({restaurantGuid:z.uuid(),
    order:z.object({guid:z.uuid()}).optional()}).passthrough(),
});
export function validToastWebhookSignature(
  rawBody:string,timestamp:string,provided:string|null,secret:string,now=Date.now()
):boolean {
  const ms=Date.parse(timestamp);
  if(!Number.isFinite(ms)||(ms>now+2*60000||now-ms>30*60000)||!provided||
    !/^[A-Za-z0-9+/]{43}=$/.test(provided))return false;
  const signature=createHmac("sha256",secret).update(rawBody+timestamp,"utf8").digest();
  const supplied=Buffer.from(provided,"base64");
  return supplied.length===signature.length&&timingSafeEqual(signature,supplied);
}

export const toastWebhookKinds=["orders","menus","stock","availability","ordering"] as const;
export type ToastWebhookKind=typeof toastWebhookKinds[number];
export function toastWebhookTarget(event:z.infer<typeof toastEventSchema>){
 const {eventCategory:c,eventType:t,details:d}=event;
 if(c==="orders"&&["order_updated","channel_order_updated"].includes(t)&&d.order?.guid)
  return {kind:"orders" as const,orderGuid:d.order.guid};
 if(c==="menus"&&t==="menus_updated"&&typeof d.publishedDate==="string"&&Number.isFinite(Date.parse(d.publishedDate)))
  return {kind:"menus" as const,version:d.publishedDate};
 if(c==="stock"&&["in_stock","out_of_stock","low_quantity"].includes(t)&&z.uuid().safeParse(d.itemGuid).success)
  return {kind:"stock" as const,itemGuid:String(d.itemGuid)};
 if(c==="restaurant_availability"&&["availability_online","availability_offline","toggle_availability_online","toggle_availability_offline"].includes(t))
  return {kind:"availability" as const};
 if(c==="ordering_schedule"&&t==="ordering_schedule_updated")return {kind:"ordering" as const};
 return null;
}
