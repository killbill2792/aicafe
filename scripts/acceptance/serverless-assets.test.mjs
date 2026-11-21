import {afterEach,describe,it} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,unlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,relative} from "node:path";
import {CRITICAL_ROUTES,PG17_WASM,verifyServerlessAssetTraces} from "./serverless-assets.mjs";

const dirs=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),"aicafe-asset-trace-"));dirs.push(root);
  const asset=join(root,PG17_WASM);mkdirSync(dirname(asset),{recursive:true});
  writeFileSync(asset,Buffer.from([0,97,115,109,1,0,0,0]));
  const traces=CRITICAL_ROUTES.map(route=>{
    const p=join(root,".next/server/app",route,"route.js.nft.json");
    mkdirSync(dirname(p),{recursive:true});
    writeFileSync(p,JSON.stringify({version:1,files:[relative(dirname(p),asset)]}));
    return p;
  });
  return {root,asset,traces};
}
describe("production serverless asset guard (Webpack and Turbopack NFT)",()=>{
  it("accepts every authentic route trace referencing the physical PG17 WASM",()=>{
    const f=fixture(),result=verifyServerlessAssetTraces(f.root);
    assert.equal(result.routes,CRITICAL_ROUTES.length);
    assert.equal(result.bytes,8);
  });
  it("rejects a missing actual binary even when the trace mentions it",()=>{
    const f=fixture();unlinkSync(f.asset);
    assert.throws(()=>verifyServerlessAssetTraces(f.root),/missing_runtime_asset/);
  });
  it("rejects an invalid or empty WASM payload",()=>{
    const f=fixture();writeFileSync(f.asset,"not a WASM");
    assert.throws(()=>verifyServerlessAssetTraces(f.root),/invalid_runtime_asset/);
  });
  it("rejects a missing route trace rather than silently checking only existing files",()=>{
    const f=fixture();unlinkSync(f.traces[0]);
    assert.throws(()=>verifyServerlessAssetTraces(f.root),/missing_serverless_trace/);
  });
  it("rejects a corrupt or empty trace",()=>{
    const f=fixture();writeFileSync(f.traces[0],"{");
    assert.throws(()=>verifyServerlessAssetTraces(f.root),/invalid_serverless_trace/);
    writeFileSync(f.traces[0],JSON.stringify({files:[]}));
    assert.throws(()=>verifyServerlessAssetTraces(f.root),/invalid_serverless_trace/);
  });
  it("rejects when one affected function omits the binary",()=>{
    const f=fixture();writeFileSync(f.traces.at(-1),JSON.stringify({version:1,files:["./unrelated.js"]}));
    assert.throws(()=>verifyServerlessAssetTraces(f.root),/untraced_runtime_asset: api\/ai\/threads/);
  });
  it("rejects an unrelated file with the same basename",()=>{
    const f=fixture();writeFileSync(f.traces[1],JSON.stringify({version:1,files:["../../../../pg-parser.wasm"]}));
    assert.throws(()=>verifyServerlessAssetTraces(f.root),/untraced_runtime_asset: api\/cron\/toast-sync/);
  });
  it("rejects absent output rather than treating it as skipped success",()=>{
    const f=fixture();rmSync(join(f.root,".next"),{recursive:true,force:true});
    assert.throws(()=>verifyServerlessAssetTraces(f.root),/missing_serverless_trace/);
  });
});
