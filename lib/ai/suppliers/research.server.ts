import "server-only";
import type {PublicSource} from "./contracts";
export function researchEnabled(){
 return process.env.SUPPLIER_RESEARCH_ENABLED==="true" && Boolean(process.env.BRAVE_SEARCH_API_KEY);
}
export async function researchPublicSources(query:string,fetcher:typeof fetch=fetch):Promise<PublicSource[]>{
 if(!researchEnabled())return [];
 // Only the fixed Brave endpoint is ever contacted: no user URL fetch / SSRF.
 const url=new URL("https://api.search.brave.com/res/v1/web/search");
 url.searchParams.set("q",query);url.searchParams.set("count","5");
 const controller=new AbortController();
 const timeout=setTimeout(()=>controller.abort(),8000);
 try{
  const r=await fetcher(url.toString(),{
   signal:controller.signal,
   headers:{"Accept":"application/json","X-Subscription-Token":process.env.BRAVE_SEARCH_API_KEY!},
   cache:"no-store",
  });
  if(!r.ok)throw new Error("research_provider_unavailable");
  const json=await r.json() as {web?:{results?:{title?:string;url?:string;description?:string}[]}};
  return (json.web?.results??[]).slice(0,5).flatMap(row=>{
   try{
    const external=new URL(row.url??"");
    if(external.protocol!=="https:")return [];
    return [{title:(row.title??"Source").slice(0,160),url:external.toString(),
     snippet:(row.description??"").slice(0,400),queriedAt:new Date().toISOString(),
     evidenceStatus:"unverified_search_snippet" as const}];
   }catch{return [];}
  });
 }finally{clearTimeout(timeout);}
}
