#!/usr/bin/env node
// Fail-closed proof of deployment-critical filesystem assets in REAL Next.js
// server function traces. Build with Webpack AND Turbopack before invoking.
// This is not a static config-string check: absent traces/assets fail.
import {existsSync,readFileSync,readdirSync,statSync} from "node:fs";
import {dirname,join,resolve,relative,sep} from "node:path";
import {pathToFileURL} from "node:url";

export const PG17_WASM="node_modules/@supabase/pg-parser/wasm/17/pg-parser.wasm";
export const CRITICAL_ROUTES=Object.freeze([
  "api/cron/whatsapp-supervisor",
  "api/cron/toast-sync",
  "api/cron/refresh-derived",
  "api/cron/supervisor-run-worker",
  "api/ai/threads/[threadId]/agent",
]);

export function verifyServerlessAssetTraces(projectRoot=process.cwd()){
  const root=resolve(projectRoot),assetPath=join(root,PG17_WASM);
  if(!existsSync(assetPath)||!statSync(assetPath).isFile())
    throw Error("missing_runtime_asset: "+PG17_WASM);
  const binary=readFileSync(assetPath);
  if(binary.length<8||binary.toString("hex",0,4)!=="0061736d")
    throw Error("invalid_runtime_asset: "+PG17_WASM);
  const appRoot=join(root,".next","server","app");
  if(!existsSync(appRoot)||!statSync(appRoot).isDirectory())
    throw Error("missing_serverless_trace_root: "+relative(root,appRoot));

  // Check EVERY generated Node API route, so a future endpoint cannot
  // silently lose the same required WASM asset. Keep an explicit minimum
  // list of routes whose startup already failed in Vercel production.
  const traces=new Map(),stack=[appRoot];
  while(stack.length){
    const directory=stack.pop();
    for(const entry of readdirSync(directory,{withFileTypes:true})){
      const file=join(directory,entry.name);
      if(entry.isDirectory())stack.push(file);
      else if(entry.isFile()&&entry.name==="route.js.nft.json"){
        const route=relative(appRoot,dirname(file)).split(sep).join("/");
        traces.set(route,file);
      }
    }
  }
  if(!traces.size)throw Error("missing_serverless_traces: no API route traces");
  for(const route of CRITICAL_ROUTES){
    if(!traces.has(route))
      throw Error("missing_serverless_trace: "+route);
  }

  for(const [route,traceFile] of traces){
    let trace;
    try{trace=JSON.parse(readFileSync(traceFile,"utf8"));}
    catch{throw Error("invalid_serverless_trace: "+route);}
    if(!trace||!Array.isArray(trace.files)||!trace.files.length||
        trace.files.some(f=>typeof f!=="string"))
      throw Error("invalid_serverless_trace: "+route);
    // NFT paths are relative to their containing trace. Basename equality
    // is insufficient: require the *actual* installed PG17 WASM binary.
    const included=trace.files.some(f=>resolve(dirname(traceFile),f)===assetPath);
    if(!included)throw Error("untraced_runtime_asset: "+route+" -> "+PG17_WASM);
  }
  return {routes:traces.size,criticalRoutes:CRITICAL_ROUTES.length,
    asset:PG17_WASM,bytes:binary.length};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{
    const result=verifyServerlessAssetTraces();
    // The package must also execute a real PG17 parse under the active Node
    // runtime (Node 22 Webpack and Node 24 Vercel-parity Turbopack CI).
    // This is a read-only, credential-free WASM runtime smoke, not SQL access.
    const {PgParser}=await import("@supabase/pg-parser");
    const parsed=await new PgParser({version:17}).parse("SELECT 1 AS probe");
    if(parsed.error||!parsed.tree||!parsed.tree.stmts?.length)
      throw Error("postgres17_wasm_runtime_smoke_failed");
    console.log("Serverless asset trace + PG17 parse proof PASSED "+JSON.stringify(result));
  }catch(error){
    console.error("scripts/acceptance/serverless-assets.mjs:1: "+(error instanceof Error?error.message:String(error)));
    process.exitCode=1;
  }
}
