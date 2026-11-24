import {createHash,createHmac,timingSafeEqual} from "node:crypto";

/** An opaque cursor binds the exact authorized query, scope and full ordered
 * result digest. Each continuation revalidates the complete result in a new
 * repeatable-read transaction. A changed result is rejected, never spliced
 * into the earlier observation. No source rows or SQL are stored in a token. */
type FingerprintInput={
 businessId:string;ownerUserId:string;threadId:string;
 mode:string;sourceType:string|null;sourceId:string|null;
 runId:string|null;leaseToken:string|null;aggregateOnly?:boolean;
 sql:string;parameters:readonly (string|number|boolean|null)[]|null;
 date_from:string|null;date_to:string|null;limit:number|null;
};
export type ResearchSnapshot={id:string;digest:string;asOf:string;totalRows:number};
const invalid=()=>new Error("invalid_query");
function fingerprint(input:FingerprintInput):string{
 return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
function mac(body:string,secret:string):Buffer{
 if(!secret||secret.length<24)throw new Error("research_not_configured");
 return createHmac("sha256",secret).update("u3-research-page-v2:"+body).digest();
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hex=/^[0-9a-f]{64}$/;
function validSnapshot(s:unknown):s is ResearchSnapshot{
 if(!s||typeof s!=="object"||Array.isArray(s))return false;
 const p=s as Record<string,unknown>;
 return typeof p.id==="string"&&uuid.test(p.id)&&typeof p.digest==="string"&&hex.test(p.digest)&&
  typeof p.asOf==="string"&&p.asOf.length<=30&&Number.isFinite(Date.parse(p.asOf))&&
  typeof p.totalRows==="number"&&Number.isSafeInteger(p.totalRows)&&p.totalRows>0&&
  Object.keys(p).sort().join(",")==="asOf,digest,id,totalRows";
}
export function researchNextCursor(input:FingerprintInput,offset:number,secret:string,snapshot:ResearchSnapshot):string{
 if(!validSnapshot(snapshot)||!Number.isSafeInteger(offset)||offset<=0||offset>=snapshot.totalRows)throw invalid();
 const body=Buffer.from(JSON.stringify({v:2,o:offset,h:fingerprint(input),s:snapshot})).toString("base64url");
 return body+"."+mac(body,secret).toString("base64url");
}
export function researchPage(input:FingerprintInput,cursor:string|null|undefined,secret:string):
 {offset:number;snapshot:ResearchSnapshot|null}{
 if(cursor===null||cursor===undefined)return {offset:0,snapshot:null};
 if(typeof cursor!=="string"||cursor.length>512)throw invalid();
 const parts=cursor.split(".");
 if(parts.length!==2||!/^[A-Za-z0-9_-]+$/.test(parts[0])||
   !/^[A-Za-z0-9_-]{43}$/.test(parts[1]))throw invalid();
 const expected=mac(parts[0],secret);
 const actual=Buffer.from(parts[1],"base64url");
 if(actual.toString("base64url")!==parts[1]||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw invalid();
 let parsed:unknown;
 try{parsed=JSON.parse(Buffer.from(parts[0],"base64url").toString("utf8"));}
 catch{throw invalid();}
 if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw invalid();
 const p=parsed as Record<string,unknown>;
 if(p.v!==2||!Number.isSafeInteger(p.o)||Number(p.o)<=0||
  p.h!==fingerprint(input)||Object.keys(p).sort().join(",")!=="h,o,s,v"||
  !validSnapshot(p.s)||Number(p.o)>=p.s.totalRows)throw invalid();
 return {offset:Number(p.o),snapshot:p.s};
}
export function researchPageOffset(input:FingerprintInput,cursor:string|null|undefined,secret:string):number{
 return researchPage(input,cursor,secret).offset;
}
