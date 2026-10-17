#!/usr/bin/env node
/** MANUAL PAID LEGACY COMPATIBILITY SEMANTIC TEST. The default investigation runtime has separate entrypoint acceptance tests; this script checks the retained legacy tool contract. */
import {readFileSync} from "node:fs";
import {SUPERVISOR_FUNCTIONS} from "../lib/ai/conversations/supervisorFunctions.mjs";
if(!process.env.OPENAI_API_KEY) {
  console.error("NOT RUN: set OPENAI_API_KEY securely, then run npm run supervisor:live-eval");
  process.exit(2);
}
const cases=JSON.parse(readFileSync(new URL("../lib/ai/conversations/semantic-eval.fixture.json",import.meta.url),"utf8"));
const matches=(actual,plans)=>plans.some(plan=>plan.every(required=>actual.some(call=>
  call.name===required.name&&Object.entries(required.arguments??{}).every(([key,val])=>call.arguments[key]===val))));
const results=[];
for(const c of cases){
  const input=[...(c.history??[]),{role:"user",content:c.question}];
  const response=await fetch("https://api.openai.com/v1/responses",{
    method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+process.env.OPENAI_API_KEY},
    body:JSON.stringify({model:process.env.SUPERVISOR_OPENAI_MODEL||"gpt-6-luna",
      instructions:[
        "You are the AI CAFE Supervisor selecting authorized read-only tools semantically.",
        "For a business question request the relevant café domain tools; multiple calls allowed.",
        "Use prior owner AND Supervisor messages for follow-up references.",
        "Distinguish human staff and AI Team, menu inventory from product sales, monthly bills from actual expenses.",
        "Use comparison tools for numeric trends instead of inventing arithmetic.",
        "The first round must request at least one real café tool or conversation_control for non-business messages.",
        "Never invent business data, payroll, costs, staffing or sales records.",
        "Cafe local date 2026-10-10, timezone America/Los_Angeles.",
      ].join("\n"),
      input,tools:SUPERVISOR_FUNCTIONS,tool_choice:"required",
      parallel_tool_calls:true,store:false,reasoning:{effort:"none"},max_output_tokens:900,
    }),
  });
  if(!response.ok) {
    const status=response.status;
    console.error("Live eval stopped: provider response",status,"for question",c.question);
    process.exit(2);
  }
  const payload=await response.json();
  const actual=(payload.output??[]).filter(item=>item.type==="function_call").map(item=>{
    let args={};try{args=JSON.parse(item.arguments);}catch{/* invalid is a failed case */}
    return {name:item.name,arguments:args};
  });
  const pass=matches(actual,c.acceptablePlans);
  results.push({question:c.question,pass,model:payload.model,actual,
    acceptablePlans:c.acceptablePlans});
  console.log(JSON.stringify(results.at(-1)));
}
const passed=results.filter(x=>x.pass).length;
console.log("LIVE GPT SEMANTIC EVAL:",passed,"/",results.length,"passed");
if(passed!==results.length)process.exitCode=1;
