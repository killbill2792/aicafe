import {createHash} from "node:crypto";
import {z} from "zod";

/** Deterministic RFC 4122 UUIDv5. The caller supplies a scoped UUID namespace
 * and a stable canonical name; no keys are derived from provider call IDs. */
export function proposalRequestKey(namespace:string,name:string){
  const ns=z.uuid().parse(namespace).replace(/-/g,"");
  const hash=createHash("sha1").update(Buffer.from(ns,"hex")).update(name,"utf8").digest("hex");
  const variant=((parseInt(hash[16],16)&3)|8).toString(16);
  return hash.slice(0,8)+"-"+hash.slice(8,12)+"-5"+hash.slice(13,16)+
    "-"+variant+hash.slice(17,20)+"-"+hash.slice(20,32);
}
