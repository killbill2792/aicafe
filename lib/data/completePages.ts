/** Read every row from a caller-scoped PostgREST source without accepting
 * the default 1,000-row transport cap as a complete business total.
 *
 * Callers MUST supply stable immutable identity and an explicit deterministic
 * .order(...).range(start,end), plus tenant/date filtering at the source.
 * Missing/duplicated keys, changing exact counts and incomplete fetches fail
 * closed. Read-only: no cache, new source authority or implicit row cutoff.
 */
/** One stable, tenant-scoped PostgREST page at a time. Row caps are transport
 * limits, not business limits: continue until the exact full set is proved.
 * Requiring unique immutable IDs and a stable exact count fails closed on
 * concurrent page drift, rather than silently publishing a partial subtotal. */
export async function readCompletePaged<T>(
 read:(start:number,end:number)=>PromiseLike<{data:T[]|null;error:unknown;count?:number|null}>,
 identity:(row:T)=>unknown
):Promise<T[]|null>{
 const rows:T[]=[];const seen=new Set<string>();let expected:number|null=null;
 for(let start=0;;start+=1000){
  if(!Number.isSafeInteger(start+999))return null;
  const page=await read(start,start+999);
  if(page.error)throw page.error;
  if(!Array.isArray(page.data)||page.data.length>1000)return null;
  if(page.count!=null){
   if(!Number.isSafeInteger(page.count)||page.count<0||
      (expected!==null&&expected!==page.count))return null;
   expected=page.count;
  }
  for(const row of page.data){
   const key=identity(row);
   if(typeof key!=="string"||!key||seen.has(key))return null;
   seen.add(key);rows.push(row);
  }
  if(expected!==null&&rows.length>expected)return null;
  if(expected!==null&&rows.length===expected)break;
  if(page.data.length<1000)break;
 }
 return expected===null||rows.length===expected?rows:null;
}
