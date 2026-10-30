import {safeMetric} from "@/lib/perf/navigationMetrics";

/** Best-effort anonymous browser timing; never store raw URLs or user content. */
export async function POST(request:Request) {
  if(request.headers.get("origin")!==new URL(request.url).origin)
    return new Response(null,{status:403});
  const text=await request.text();
  if(text.length>1200)return new Response(null,{status:413});
  let body:unknown;
  try{body=JSON.parse(text);}catch{return new Response(null,{status:400});}
  const metric=safeMetric(body);
  if(!metric)return new Response(null,{status:400});
  console.info("[nav-timing] "+JSON.stringify(metric));
  return new Response(null,{status:204,headers:{"Cache-Control":"no-store"}});
}
