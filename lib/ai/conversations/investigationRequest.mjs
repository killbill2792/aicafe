import {supervisorModelProfile} from "./supervisorRequest.mjs";
/** Provider wire schema shared by production and the explicit paid smoke check.
 * The server's Zod contract additionally enforces byte/length/shape limits. */
export const INVESTIGATION_STEP_JSON_SCHEMA={
  type:"object",additionalProperties:false,
  required:["action","capabilityId","argumentsJson","responseJson"],
  properties:{action:{type:"string",enum:["read","calculate","answer"]},
    capabilityId:{type:["string","null"]},argumentsJson:{type:["string","null"]},responseJson:{type:["string","null"]}},
};
/** A bounded finalization step: forbid additional reads when there is only
 * enough model budget left to draft and independently review the answer. */
export const INVESTIGATION_FINAL_STEP_JSON_SCHEMA={
  type:"object",additionalProperties:false,
  required:["action","capabilityId","argumentsJson","responseJson"],
  properties:{
    action:{type:"string",enum:["answer"]},
    capabilityId:{type:"null"},argumentsJson:{type:"null"},
    responseJson:{type:"string"},
  },
};
/** Production evidence (investigation-step provider_incomplete at the prior 2200
 * cap) showed real investigation steps running out of output budget before the
 * model finished, even with reasoning effort set to "none". maxOutputTokens is
 * the caller's own remaining per-turn allowance, already clamped to at most
 * 6000: a fixed cap here could let one call's output push the turn's total
 * past its INVESTIGATION_LIMITS.totalOutputTokens backstop by nearly a full
 * cap's worth. */
export function buildInvestigationRequest({model,name,schema,instructions,context,maxOutputTokens,tools}){
  return {model,...supervisorModelProfile(model),store:false,max_output_tokens:maxOutputTokens,instructions,
    input:[{role:"user",content:JSON.stringify(context)}],
    // Native function calling for capability selection: the model requests a
    // real tool by name/arguments instead of hand-writing a JSON envelope that
    // itself describes another JSON blob. Structured-output text.format stays
    // for the case the model answers directly instead of calling a tool.
    // Permit independent source reads in one model selection. The server still
    // validates scope/dependencies and dispatches only bounded independent
    // P1 reads concurrently; calculations and dependent readers remain sequential.
    ...(tools&&tools.length?{tools:tools.map(t=>({type:"function",name:t.name,
      description:t.description,parameters:t.parameters})),parallel_tool_calls:true}:{}),
    text:{format:{type:"json_schema",name,strict:true,schema}}};
}
