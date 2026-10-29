import {describe,expect,it} from "vitest";
import {readdirSync,readFileSync,existsSync} from "node:fs";
import {join,relative,sep} from "node:path";

/** Scanner covers production source, not tests, generated output or documentation. */
function sources(){
 const root=process.cwd(),all:string[]=[];
 const walk=(dir:string)=>{
  if(!existsSync(dir))return;
  for(const entry of readdirSync(dir,{withFileTypes:true})){
   const full=join(dir,entry.name);
   if(entry.isDirectory()){if(!["node_modules",".next","coverage"].includes(entry.name))walk(full);continue;}
   if(!entry.isFile()||!/\.(?:ts|tsx|js|jsx|mjs)$/.test(entry.name)||
      /(?:\.test|\.spec|\.stories)\./.test(entry.name))continue;
   all.push(full);
  }
 };
 ["lib","app","components"].forEach(dir=>walk(join(root,dir)));
 return all.map(full=>({path:relative(root,full).split(sep).join("/"),source:readFileSync(full,"utf8")}));
}
const banned=[
 "compactCalculationReply","forcedPricingClarifyText","isMilkSwapQuestion",
 "requestedMilkTarget","answerFromSavedReasons","localizedToolNote",
 "uncertaintyPhrases","numericQuestion","chatExperienceFlags",
 "CHAT_STYLE_V2","CHAT_JOBS","CHAT_MEMORY","AI_PROVIDER"
];
/** Exception: a D-owned file may be changed by D, not PR 1. Only this historical comment remains. */
const exceptions:Readonly<Record<string,readonly string[]>>={
 "lib/ai/agent/tools/index.ts":["CHAT_MEMORY"]
};
describe("banned production patterns",()=>{
 it("has no retired model-rewriting, regex intent or flag symbols",()=>{
  const violations:string[]=[];
  for(const file of sources())for(const token of banned){
   if(file.source.includes(token)&&!exceptions[file.path]?.includes(token))
    violations.push(`${file.path}: ${token}`);
  }
  expect(violations).toEqual([]);
 });
 it("never introduces an unscoped USD label or a UTC today in the chat path",()=>{
  const violations:string[]=[];
  for(const file of sources()){
   if(/currency\s*:\s*["']USD["']/.test(file.source))violations.push(`${file.path}: hard-coded USD`);
   file.source.split("\n").forEach((line,index)=>{
    if(/toISOString\(\)\.slice\(0,\s*10\)/.test(line)&&
       /\b(?:today|currentDay|todayUtc)\b/i.test(line)&&
       !file.source.includes("// allowed: UTC quota bucket"))
      violations.push(`${file.path}:${index+1}: UTC today`);
   });
  }
  expect(violations).toEqual([]);
 });
 it("rejects all retired alternate data pipelines",()=>{
  const actual=sources().map(f=>f.path);
  expect(actual.filter(path=>/^lib\/ai\/supervisor\/(p2|p3)\//.test(path)||
   /^lib\/metrics\/p1/.test(path)||/^lib\/ai\/conversations\/toolRegistry/.test(path))).toEqual([]);
 });
 it("allows model reply assignments only for stream deltas and explicitly labeled empty fills",()=>{
  const loop=sources().find(f=>f.path==="lib/ai/agent/loop.server.ts")?.source;
  expect(loop).toBeDefined();
  const violations=(loop??"").split("\n").flatMap((line,index)=>{
   if(!/\btext\s*(?:\+=|=(?!=))/.test(line))return [];
   if(/\blet text\s*=/.test(line)||
      /text\s*\+=\s*event\.delta/.test(line)||
      /\/\/ allowed: empty-reply fill/.test(line))return [];
   return [`loop.server.ts:${index+1}: ${line.trim()}`];
  });
  expect(violations).toEqual([]);
 });
});
