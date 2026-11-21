#!/usr/bin/env node
// Fail-closed proof of deployment-critical filesystem assets in REAL Next.js
// server function traces. Build with Webpack AND Turbopack before invoking.
// This is not a static config-string check: absent traces/assets fail.
import {existsSync,readFileSync,statSync} from "node:fs";
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
  for(const route of CRITICAL_ROUTES){
    const traceFile=join(root,".next","server","app",route,"route.js.nft.json");
    if(!existsSync(traceFile)||!statSync(traceFile).isFile())
      throw Error("missing_serverless_trace: "+relative(root,traceFile));
    let trace;
    try{trace=JSON.parse(readFileSync(traceFile,"utf8"));}
    catch{throw Error("invalid_serverless_trace: "+relative(root,traceFile));}
    if(!trace||!Array.isArray(trace.files)||!trace.files.length||
        trace.files.some(f=>typeof f!=="string"))
      throw Error("invalid_serverless_trace: "+relative(root,traceFile));
    // NFT 'files' paths are relative to the trace, not to the project root.
    // Require a path resolving to the EXACT installed binary. No basename
    // coincidences or fake bundled manifest path can pass the guard.
    const included=trace.files.some(f=>resolve(dirname(traceFile),f)===assetPath);
    if(!included)throw Error("untraced_runtime_asset: "+route+" -> "+PG17_WASM);
  }
  return {routes:CRITICAL_ROUTES.length,asset:PG17_WASM,bytes:binary.length};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{
    const result=verifyServerlessAssetTraces();
    console.log("Serverless asset trace proof PASSED "+JSON.stringify(result));
  }catch(error){
    console.error("scripts/acceptance/serverless-assets.mjs:1: "+(error instanceof Error?error.message:String(error)));
    process.exitCode=1;
  }
}
