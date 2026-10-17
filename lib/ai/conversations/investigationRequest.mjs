import {supervisorModelProfile} from "./supervisorRequest.mjs";
/** Provider wire schema shared by production and the explicit paid smoke check.
 * The server's Zod contract additionally enforces byte/length/shape limits. */
export const INVESTIGATION_STEP_JSON_SCHEMA={
  type:"object",additionalProperties:false,
  required:["action","capabilityId","argumentsJson","responseJson"],
  properties:{action:{type:"string",enum:["read","calculate","answer"]},
    capabilityId:{type:["string","null"]},argumentsJson:{type:["string","null"]},responseJson:{type:["string","null"]}},
};
/** Production evidence (investigation-step provider_incomplete at the prior 2200
 * cap) showed real investigation steps running out of output budget before the
 * model finished, even with reasoning effort set to "none". Raised well below
 * the per-turn INVESTIGATION_LIMITS.totalOutputTokens backstop (16000), which
 * still caps total consumption across a turn's up to 8 model calls. */
export function buildInvestigationRequest({model,name,schema,instructions,context}){
  return {model,...supervisorModelProfile(model),store:false,max_output_tokens:6000,instructions,
    input:[{role:"user",content:JSON.stringify(context)}],
    text:{format:{type:"json_schema",name,strict:true,schema}}};
}
