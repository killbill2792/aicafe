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
export function buildInvestigationRequest({model,name,schema,instructions,context,maxOutputTokens}){
  return {model,...supervisorModelProfile(model),store:false,max_output_tokens:maxOutputTokens,instructions,
    input:[{role:"user",content:JSON.stringify(context)}],
    text:{format:{type:"json_schema",name,strict:true,schema}}};
}
