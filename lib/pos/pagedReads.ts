/** Stable, bounded PostgREST pagination for a complete set of canonical rows.
 * A caller must include deterministic .order(...) before applying .range().
 * Never silently accept the 1,000-row provider cap as exhaustive.
 */
const PAGE_SIZE=500;
const MAX_PAGES=80;
export async function readAllPosRows<T>(
  load:(first:number,last:number)=>PromiseLike<{data:T[]|null;error:unknown}>,
  label:string,
):Promise<T[]> {
 const rows:T[]=[];
 for(let page=0;page<MAX_PAGES;page++){
  const first=page*PAGE_SIZE;
  const {data,error}=await load(first,first+PAGE_SIZE-1);
  if(error||data===null)throw new Error("Incomplete POS read: "+label);
  rows.push(...data);
  if(data.length<PAGE_SIZE)return rows;
 }
 throw new Error("POS read exceeded safety limit: "+label);
}
export function posIdBatches(ids:string[],size=100):string[][] {
 const unique=[...new Set(ids)];
 return Array.from({length:Math.ceil(unique.length/size)},(_,i)=>unique.slice(i*size,(i+1)*size));
}
