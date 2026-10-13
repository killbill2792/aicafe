import "server-only";
import {createHmac,timingSafeEqual} from "node:crypto";
import {z} from "zod";
export const toastEventSchema=z.object({
  guid:z.uuid(),timestamp:z.iso.datetime({offset:true}),eventCategory:z.string(),
  eventType:z.string(),details:z.object({restaurantGuid:z.uuid()}).passthrough(),
});
export function validToastWebhookSignature(
  rawBody:string,timestamp:string,provided:string|null,secret:string,now=Date.now()
):boolean {
  const ms=Date.parse(timestamp);
  if(!Number.isFinite(ms)||Math.abs(now-ms)>5*60*1000||!provided||
    !/^[A-Za-z0-9+/]{43}=$/.test(provided))return false;
  const signature=createHmac("sha256",secret).update(rawBody+timestamp,"utf8").digest();
  const supplied=Buffer.from(provided,"base64");
  return supplied.length===signature.length&&timingSafeEqual(signature,supplied);
}
