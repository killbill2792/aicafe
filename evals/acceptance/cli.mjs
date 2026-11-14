#!/usr/bin/env node
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {scoreAcceptance} from "./evidence.mjs";

// No provider calls and no database access here. This is deliberately an
// independent deterministic scorer; trusted execution captures evidence.
function argumentsOf(argv){
 const options={mode:"calibration",truth:"evals/acceptance/fixtures/calibration-truth.json",
  observations:"evals/acceptance/fixtures/calibration-observations.json"};
 for(let i=0;i<argv.length;i+=2){
  const key=argv[i];
  if(!["--mode","--truth","--observations"].includes(key)||!argv[i+1])
   throw new Error("Usage: node evals/acceptance/cli.mjs [--mode calibration|live] [--truth PATH] [--observations PATH]");
  const field=key.slice(2);
  if(options["__"+field])throw new Error("duplicate_argument");
  options[field]=argv[i+1];options["__"+field]=true;
 }
 if(!["calibration","live"].includes(options.mode))throw new Error("invalid_mode");
 // Prevent accidental scoring of a live run using embedded synthetic fixtures.
 if(options.mode==="live"&&(!options.__truth||!options.__observations))
  throw new Error("Live evidence must supply independently labeled truth and captured observations");
 return options;
}
try{
 const args=argumentsOf(process.argv.slice(2));
 const truth=JSON.parse(readFileSync(resolve(args.truth),"utf8"));
 const observations=JSON.parse(readFileSync(resolve(args.observations),"utf8"));
 const scored=scoreAcceptance(truth,observations,{mode:args.mode});
 console.log(JSON.stringify(scored,null,2));
 if(args.mode==="live"){
  console.log("LIVE OBJECTIVE CHECKS ONLY. Source attestation, subjective human rubric and competitor comparison remain separate mandatory gates.");
 }
}catch(error){
 console.error("ACCEPTANCE FAIL: "+(error instanceof Error?error.message:"unknown"));
 process.exitCode=1;
}
