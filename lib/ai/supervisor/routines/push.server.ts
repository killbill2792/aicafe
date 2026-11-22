import "server-only";
import {createCipheriv,createDecipheriv,createECDH,createHash,createPrivateKey,
  hkdfSync,randomBytes,sign} from "node:crypto";
import type {SupabaseClient} from "@supabase/supabase-js";

/** All notifications contain an opaque local Work route, never café or source
 * details. HTTPS provider allowlist protects the server from forged endpoints. */
export type SavedPush={endpoint:string;keys:{p256dh:string;auth:string}};
const allowedHost=(host:string)=>host==="fcm.googleapis.com"||
  host==="updates.push.services.mozilla.com"||
  host.endsWith(".push.services.mozilla.com")||
  host==="web.push.apple.com"||host.endsWith(".push.apple.com")||
  host.endsWith(".notify.windows.com");
const decode=(input:string)=>Buffer.from(input,"base64url");
export function validatePushSubscription(raw:SavedPush):SavedPush{
  const url=new URL(raw.endpoint);
  if(url.protocol!=="https:"||url.username||url.password||url.port||
    !allowedHost(url.hostname)||raw.endpoint.length>2048||
    decode(raw.keys.p256dh).length!==65||decode(raw.keys.auth).length!==16)
    throw Error("invalid_push_subscription");
  if(!raw.keys.p256dh||!raw.keys.auth||decode(raw.keys.p256dh)[0]!==4)
    throw Error("invalid_push_keys");
  return {endpoint:url.toString(),keys:{
    p256dh:raw.keys.p256dh,auth:raw.keys.auth,
  }};
}
export function pushAvailable():boolean{
  return process.env.SUPERVISOR_U4_PUSH_ENABLED==="true"&&
    !!process.env.SUPERVISOR_PUSH_STORAGE_KEY&&
    !!process.env.SUPERVISOR_PUSH_VAPID_PUBLIC_KEY&&
    !!process.env.SUPERVISOR_PUSH_VAPID_PRIVATE_KEY&&
    !!process.env.SUPERVISOR_PUSH_VAPID_SUBJECT;
}
function storageKey(){
  const key=decode(process.env.SUPERVISOR_PUSH_STORAGE_KEY??"");
  if(key.length!==32)throw Error("invalid_push_storage_key");
  return key;
}
export function pushDeviceHash(endpoint:string):string{
  return createHash("sha256").update(endpoint).digest("hex");
}
export function sealPushSubscription(value:SavedPush):string{
  const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",storageKey(),nonce);
  const raw=Buffer.from(JSON.stringify(validatePushSubscription(value)),"utf8");
  const sealed=Buffer.concat([cipher.update(raw),cipher.final()]);
  return Buffer.concat([nonce,cipher.getAuthTag(),sealed]).toString("base64url");
}
export function openPushSubscription(sealed:string):SavedPush{
  const buffer=decode(sealed);
  if(buffer.length<29)throw Error("invalid_push_ciphertext");
  const dec=createDecipheriv("aes-256-gcm",storageKey(),buffer.subarray(0,12));
  dec.setAuthTag(buffer.subarray(12,28));
  return validatePushSubscription(JSON.parse(Buffer.concat([
    dec.update(buffer.subarray(28)),dec.final()]).toString("utf8")) as SavedPush);
}
function pushPayload(value:SavedPush,plain:string):Buffer{
  const clientKey=decode(value.keys.p256dh),auth=decode(value.keys.auth);
  const ephemeral=createECDH("prime256v1");ephemeral.generateKeys();
  const serverKey=ephemeral.getPublicKey();
  const shared=ephemeral.computeSecret(clientKey);
  const info=Buffer.concat([Buffer.from("WebPush: info\0"),clientKey,serverKey]);
  const ikm=Buffer.from(hkdfSync("sha256",shared,auth,info,32));
  const salt=randomBytes(16);
  const key=Buffer.from(hkdfSync("sha256",ikm,salt,
    Buffer.from("Content-Encoding: aes128gcm\0"),16));
  const nonce=Buffer.from(hkdfSync("sha256",ikm,salt,
    Buffer.from("Content-Encoding: nonce\0"),12));
  const cipher=createCipheriv("aes-128-gcm",key,nonce);
  const encrypted=Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(plain,"utf8"),Buffer.from([2])])),
    cipher.final(),cipher.getAuthTag()]);
  const recordSize=Buffer.alloc(4);
  recordSize.writeUInt32BE(4096,0);
  return Buffer.concat([salt,recordSize,Buffer.from([serverKey.length]),serverKey,encrypted]);
}
function vapidJwt(endpoint:string):string{
  const publicKey=decode(process.env.SUPERVISOR_PUSH_VAPID_PUBLIC_KEY??"");
  const privateKey=decode(process.env.SUPERVISOR_PUSH_VAPID_PRIVATE_KEY??"");
  const subject=process.env.SUPERVISOR_PUSH_VAPID_SUBJECT??"";
  if(publicKey.length!==65||privateKey.length!==32||
    !(/^(mailto:[^@\s]+@[^@\s]+|https:\/\/[^/]+)$/u.test(subject)))
    throw Error("push_vapid_not_configured");
  const jwtPart=(item:unknown)=>Buffer.from(JSON.stringify(item)).toString("base64url");
  const jwt=jwtPart({typ:"JWT",alg:"ES256"})+"."+
    jwtPart({aud:new URL(endpoint).origin,exp:Math.floor(Date.now()/1000)+3600,sub:subject});
  const key=createPrivateKey({format:"jwk",key:{
    kty:"EC",crv:"P-256",d:privateKey.toString("base64url"),
    x:publicKey.subarray(1,33).toString("base64url"),
    y:publicKey.subarray(33,65).toString("base64url"),
  }});
  return jwt+"."+sign("sha256",Buffer.from(jwt),{
    key,dsaEncoding:"ieee-p1363"}).toString("base64url");
}
/** Browser providers only receive a generic notification, not the report. */
export async function sendPushReport(value:SavedPush,runId:string):Promise<"sent"|"gone"|"retry">{
  const subscription=validatePushSubscription(value);
  if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(runId))
    throw Error("invalid_push_run");
  const url="/api/ai/work/open?run="+encodeURIComponent(runId);
  const payload=pushPayload(subscription,JSON.stringify({url}));
  const response=await fetch(subscription.endpoint,{
    method:"POST",signal:AbortSignal.timeout(7000),
    headers:{"Content-Encoding":"aes128gcm","Content-Type":"application/octet-stream",
      "Authorization":"vapid t="+vapidJwt(subscription.endpoint)+
        ", k="+process.env.SUPERVISOR_PUSH_VAPID_PUBLIC_KEY,
      "TTL":"3600","Urgency":"normal"},
    body:new Uint8Array(payload),
    redirect:"error",
  });
  if(response.ok)return "sent";
  return response.status===404||response.status===410?"gone":"retry";
}
/** The existing refresh-derived cron calls this bounded transport delivery.
 * Sending is intentionally independent of Luna paid work and report validity. */
export async function deliverDuePushReports(db:SupabaseClient,limit=6):
  Promise<{sent:number;retried:number;failed:number}>{
  const result={sent:0,retried:0,failed:0};
  if(!pushAvailable())return result;
  // The previous worker may have crashed after claiming its final allowed
  // transport attempt. Settle those expired leases before admitting work;
  // never send a fifth push. Count terminal failures in the cron telemetry.
  const reap=await db.rpc("u4_reap_expired_push_receipts",{
    p_now:new Date().toISOString(),p_limit:100,
  });
  if(reap.error){result.failed++;return result;}
  result.failed+=Number(reap.data??0);
  for(let n=0;n<limit;n++){
    const claim=await db.rpc("u4_claim_push_receipt",{p_now:new Date().toISOString()});
    if(claim.error){result.failed++;break;}
    if(!claim.data)break;
    const entry=claim.data as Record<string,string>;
    let delivered=false,permanent=false;
    try{
      const outcome=await sendPushReport(openPushSubscription(entry.sealedSubscription),
        entry.runId);
      delivered=outcome==="sent";permanent=outcome==="gone";
    }catch{/* Retry with database bounded backoff; no credentials in logs. */}
    const finished=await db.rpc("u4_finish_push_receipt",{
      p_business_id:entry.businessId,p_owner_user_id:entry.ownerUserId,
      p_device_hash:entry.deviceHash,p_run_id:entry.runId,
      p_lease_token:entry.leaseToken,p_delivered:delivered,
      p_permanent:permanent,p_now:new Date().toISOString(),
    });
    if(finished.error||finished.data!==true)result.failed++;
    else if(delivered)result.sent++;
    else result.retried++;
  }
  return result;
}
