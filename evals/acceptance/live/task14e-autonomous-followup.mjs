#!/usr/bin/env node
import {spawnSync} from "node:child_process";
import {existsSync,realpathSync} from "node:fs";
import {resolve,dirname,sep} from "node:path";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {verifyCheckoutHead} from "./runner.mjs";
const env=process.env;
assertLocalLiveEnvironment(env);verifyCheckoutHead(env.HEAD_SHA);
if(env.AICAFE_SHARED_LUNA!=="1"||env.AICAFE_SHARED_LUNA_SCENARIO!=="14e-autonomous-followup"||env.AICAFE_SHARED_LUNA_CANDIDATE!=="1")throw Error("trusted_shared_luna_candidate_required");
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=="--output"||args[2]!=="--scope-output")throw Error("output_and_scope_required");
const file=resolve(args[1]),scope=resolve(args[3]),root=realpathSync(process.cwd());
for(const f of [file,scope]){const parent=realpathSync(dirname(f));if(existsSync(f)||parent===root||parent.startsWith(root+sep))throw Error("private_fresh_output_required");}
if(file===scope)throw Error("distinct_outputs_required");
const run=spawnSync(process.execPath,["node_modules/vitest/vitest.mjs","run","lib/ai/supervisor/routines/financialEvidence.server.test.ts","--pool=threads","--maxWorkers=1"],{stdio:"inherit",env:{...env,AICAFE_14E_PROOF:file,AICAFE_14E_SCOPE:scope},timeout:520000});
if(run.error||run.status!==0||!existsSync(file)||!existsSync(scope))throw Error("autonomous_finance_proof_missing");
