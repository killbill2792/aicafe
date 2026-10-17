import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {SUPERVISOR_FUNCTIONS} from "./supervisorFunctions.mjs";
import {buildSupervisorInstructions,buildSupervisorRequest,supervisorModelProfile} from "./supervisorRequest.mjs";

const instructions=buildSupervisorInstructions({locale:"en",asOf:"2026-10-11",timezone:"America/Los_Angeles"});
const input=[{role:"user",content:"What are my monthly bills?"}];
const build=(model:string,round=0)=>buildSupervisorRequest({model,instructions,input,round});

describe("Compatibility Responses request model profiles",()=>{
  it("includes Luna reasoning=none and preserves every strict field",()=>{
    const request=build("gpt-6-luna");
    expect(request.reasoning).toEqual({effort:"none"});
    expect(request.model).toBe("gpt-6-luna");
    expect(supervisorModelProfile("gpt-6-luna")).toEqual({reasoning:{effort:"none"}});
  });
  it.each(["gpt-4.1","gpt-4.1-mini","gpt-4.1-nano","gpt-4.1-2025-04-14",
    "gpt-4.1-mini-2025-04-14","gpt-4.1-nano-2025-04-14","other-future-model"])(
    "omits reasoning completely for nonreasoning/unknown profile %s",model=>{
      const request=build(model);
      expect(Object.hasOwn(request,"reasoning")).toBe(false);
      expect(supervisorModelProfile(model)).toEqual({});
    });
  it.each(["gpt-6-luna","gpt-4.1-mini","gpt-4.1-mini-2025-04-14"])(
    "retains the fourteen original tools plus request-scope metadata, strict final schema and all shared fields for %s",model=>{
      const first=build(model,0),later=build(model,1);
      for(const request of [first,later]){
        expect(request).toMatchObject({model,instructions,input,
          store:false,max_output_tokens:1300,parallel_tool_calls:true});
        expect(request.tools).toBe(SUPERVISOR_FUNCTIONS);
        expect(request.tools.map((tool:{name:string})=>tool.name)).toHaveLength(15);
        expect(request.text.format).toMatchObject({type:"json_schema",name:"supervisor_final",strict:true,
          schema:expect.objectContaining({type:"object",additionalProperties:false,
            required:["headline","summary","fact_ids","task_ids","insight_ids","evidence_refs"]})});
        expect(request.text.format.schema.properties).toHaveProperty("fact_ids");
      }
      expect(first.tool_choice).toBe("required");
      expect(later.tool_choice).toBe("auto");
      const {reasoning:_firstReasoning,...firstShared}=first;
      const {reasoning:_laterReasoning,...laterShared}=later;
      expect(_firstReasoning).toEqual(_laterReasoning);
      expect({...firstShared,tool_choice:"auto"}).toEqual(laterShared);
    });
  it("the default runtime and optional smoke share the investigation request builder",()=>{
    const runtime=readFileSync("lib/ai/supervisor/investigation/model.server.ts","utf8");
    const smoke=readFileSync("scripts/supervisor-provider-smoke.mjs","utf8");
    expect(runtime).toContain("buildInvestigationRequest({");
    expect(smoke).toContain("buildInvestigationRequest({");
    expect(smoke).toContain("INVESTIGATION_STEP_JSON_SCHEMA");
    expect(smoke).not.toContain('reasoning:{effort:');
  });
});
