#!/usr/bin/env node
// Fail-closed PR path classification from checked-out Git commits, not the
// installation's rate-limited GitHub REST "list pull request files" endpoint.
import {execFileSync} from "node:child_process";
import {appendFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {parseNameStatus} from "../e2e/targeted.mjs";

const git=(...args)=>execFileSync("git",args,{encoding:"utf8",maxBuffer:16*1024*1024});
const docsPath=path=>path.startsWith("docs/")||path.endsWith(".md")||
  path.startsWith(".github/ISSUE_TEMPLATE/");
const e2ePath=path=>path.startsWith("e2e/")||path.startsWith("tests/e2e/")||
  /(?:^|\/)[^/]+\.(?:e2e|spec)\.[^/]+$/u.test(path)||
  /^playwright\.config\.[^/]+$/u.test(path)||
  /^scripts\/[^/]*(?:visual|screenshots)[^/]*$/u.test(path)||
  /^\.github\/workflows\/[^/]*(?:visual|screenshots)[^/]*\.yml$/u.test(path);

export function classifyPrPaths(paths){
 if(!paths.length)throw new Error("empty PR diff: cannot classify changed paths");
 const docs=paths.some(docsPath),nonDocs=paths.some(path=>!docsPath(path));
 return {
  code:String(nonDocs),
  e2e:String(paths.some(e2ePath)),
  supervisor:String(paths.some(path=>path.startsWith("lib/ai/"))),
  "docs-only":String(docs),
  "non-docs":String(nonDocs),
 };
}
export function changedPrPaths(baseSha,headSha){
 if(![baseSha,headSha].every(s=>/^[a-f0-9]{40}$/u.test(s||"")))
  throw new Error("validated base and head SHAs required");
 const mergeBase=git("merge-base",baseSha,headSha).trim();
 if(!/^[a-f0-9]{40}$/u.test(mergeBase))throw new Error("invalid merge base");
 const raw=execFileSync("git",["diff","--name-status","-z","-M",mergeBase,headSha,"--"],
  {maxBuffer:16*1024*1024});
 return parseNameStatus(raw);
}
export function run(env=process.env){
 const paths=changedPrPaths(env.BASE_SHA,env.HEAD_SHA);
 const result=classifyPrPaths(paths);
 if(!env.GITHUB_OUTPUT)throw new Error("required GitHub Actions output file absent");
 appendFileSync(env.GITHUB_OUTPUT,Object.entries(result).map(([key,value])=>key+"="+value+"\n").join(""));
 console.log("Local PR classification:",JSON.stringify({files:paths.length,...result}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 try{run();}catch(error){console.error("PR classifier:",error.message);process.exitCode=1;}
