/** Never interpret a truncated Supabase page as the entire financial history.
 * Stable ordering MUST be specified by callers before .range().
 */
export async function readAllPages<T>(
 fetchPage:(start:number,end:number)=>PromiseLike<{data:T[]|null;error:unknown}>,
 batchSize=200
):Promise<T[]>{
 if(!Number.isInteger(batchSize)||batchSize<1||batchSize>1000)
  throw new Error("Invalid Toast page size");
 const all:T[]=[];
 for(let start=0;;start+=batchSize){
  const {data,error}=await fetchPage(start,start+batchSize-1);
  if(error||!Array.isArray(data))throw new Error("Toast owner history unavailable");
  all.push(...data);
  if(data.length<batchSize)return all;
 }
}
