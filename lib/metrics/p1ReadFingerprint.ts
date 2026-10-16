import { createHash } from "node:crypto";

/** Content-address the COMPLETE validated, authorized P1 read observation.
 * This is NOT a database row revision or a transaction snapshot. Its purpose
 * is to make captured read evidence reproducible and expose changed content
 * without falsely upgrading an unversioned read to a verified source.
 */
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value!==null&&typeof value==="object")return Object.fromEntries(
    Object.entries(value as Record<string,unknown>)
      .sort(([a],[b])=>a<b?-1:a>b?1:0)
      .map(([k,v])=>[k,canonical(v)]));
  return value;
}
export function fingerprintP1Observation(input:{
  businessId:string;asOf:string;timezone:string;
  readerId:string;selectorId:string;selectorVersion:number;
  purpose:string;query:unknown;value:unknown;quality:unknown;
}):string{
  if(!input.businessId||!/^\d{4}-\d{2}-\d{2}$/.test(input.asOf)||
    !input.timezone||!input.readerId||!input.selectorId||!input.purpose)
    throw new Error("unscoped_read_fingerprint");
  const canonicalJson=JSON.stringify(canonical(input));
  if(typeof canonicalJson!=="string"||canonicalJson.length>500_000)
    throw new Error("unbounded_read_fingerprint");
  return "sha256:"+createHash("sha256").update(
    "ai-cafe:p1:observed-content:v1\n"+canonicalJson).digest("hex");
}
