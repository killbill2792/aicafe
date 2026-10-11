#!/usr/bin/env node
// Developer-only live semantic evaluation. Never run in CI. Requires BOTH --live and explicit OPENAI_API_KEY.
import { readFileSync } from "node:fs";
const enabled = process.argv.includes("--live");
if (!enabled || !process.env.OPENAI_API_KEY) {
  console.error("Live Supervisor eval is opt-in: OPENAI_API_KEY=... node scripts/supervisor-live-eval.mjs --live");
  process.exitCode=2;
} else {
  const cases = JSON.parse(readFileSync(new URL("../lib/ai/conversations/semantic-eval.fixture.json",import.meta.url),"utf8"));
  const names=["get_cafe_overview","get_sales","get_menu","get_financials","get_staff","get_team","get_pricing","get_owner_rules"];
  const tools = names.map(name=>({
    type:"function",name,description:"Read-only domain capability for authenticated café: "+name,
    strict:true,parameters:{type:"object",properties:{probe:{type:"string",enum:["read_only"]}},
      required:["probe"],additionalProperties:false},
  }));
  let successes=0;
  for(const example of cases) {
    const response=await fetch("https://api.openai.com/v1/responses",{
      method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+process.env.OPENAI_API_KEY},
      body:JSON.stringify({
        model:process.env.SUPERVISOR_OPENAI_MODEL||"gpt-6-luna",
        instructions:"Choose the appropriate read-only café domain tools semantically. No DB writes, no answer from memory. Date and prior turns are implicit. Use at least one relevant tool. Staff and AI Team are distinct.",
        input:example.question,tools,tool_choice:"required",parallel_tool_calls:true,
        reasoning:{effort:"none"},store:false,max_output_tokens:350,
      }),
    });
    if(!response.ok) throw Error("OpenAI eval HTTP "+response.status);
    const body=await response.json();
    const selected=(body.output??[]).filter(x=>x.type==="function_call").map(x=>x.name);
    const ok=example.expectedTools.some(name=>selected.includes(name));
    if(ok) successes++;
    process.stdout.write((ok?"PASS":"FAIL")+" "+JSON.stringify({question:example.question,
      expected:example.expectedTools,actual:selected})+"\n");
  }
  console.log("Semantic eval:",successes+"/"+cases.length);
  if(successes!==cases.length) process.exitCode=1;
}
