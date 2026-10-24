import {createHash,timingSafeEqual} from "node:crypto";

/** Compare fixed-size hashes so malformed header lengths do not leak timing or throw. */
export function verifyBearer(request:Request,secret:string|undefined):boolean {
 if(!secret)return false;
 const header=request.headers.get("authorization");
 if(!header?.startsWith("Bearer ")||header.length<=7)return false;
 const supplied=header.slice(7);
 const digest=(value:string)=>createHash("sha256").update(value,"utf8").digest();
 return timingSafeEqual(digest(supplied),digest(secret));
}
