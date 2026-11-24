import {createHash,createHmac,timingSafeEqual} from "node:crypto";

/** Cursor for the existing read-only SQL research tool. An untrusted model
 * cannot invent an offset, change the source query, or replay another
 * café/owner/thread/leased investigation's continuation. The database rechecks
 * those rights independently on EVERY page. No café rows or SQL are stored
 * in the token. The cursor proves request continuity, NOT a cross-page MVCC
 * snapshot (each query still has its own read-only transaction). */
type FingerprintInput={
  businessId:string;ownerUserId:string;threadId:string;
  mode:string;sourceType:string|null;sourceId:string|null;
  runId:string|null;leaseToken:string|null;
  sql:string;parameters:readonly (string|number|boolean|null)[]|null;
  date_from:string|null;date_to:string|null;limit:number|null;
};
const invalid=()=>new Error("invalid_query");
function fingerprint(input:FingerprintInput):string{
 return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
function mac(body:string,secret:string):Buffer{
 if(!secret||secret.length<24)throw new Error("research_not_configured");
 return createHmac("sha256",secret).update("u3-research-page-v1:"+body).digest();
}
export function researchNextCursor(input:FingerprintInput,offset:number,secret:string):string{
 if(!Number.isSafeInteger(offset)||offset<=0)throw invalid();
 const body=Buffer.from(JSON.stringify({v:1,o:offset,h:fingerprint(input)})).toString("base64url");
 return body+"."+mac(body,secret).toString("base64url");
}
export function researchPageOffset(input:FingerprintInput,cursor:string|null|undefined,secret:string):number{
 if(cursor===null||cursor===undefined)return 0;
 if(typeof cursor!=="string"||cursor.length>512)throw invalid();
 const parts=cursor.split(".");
 if(parts.length!==2||!/^[A-Za-z0-9_-]+$/.test(parts[0])||
   !/^[A-Za-z0-9_-]{43}$/.test(parts[1]))throw invalid();
 const expected=mac(parts[0],secret);
 const actual=Buffer.from(parts[1],"base64url");
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw invalid();
 let parsed:unknown;
 try{parsed=JSON.parse(Buffer.from(parts[0],"base64url").toString("utf8"));}
 catch{throw invalid();}
 if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw invalid();
 const p=parsed as Record<string,unknown>;
 if(p.v!==1||!Number.isSafeInteger(p.o)||Number(p.o)<=0||
   p.h!==fingerprint(input)||Object.keys(p).sort().join(",")!=="h,o,v")
   throw invalid();
 return Number(p.o);
}
