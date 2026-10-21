import {ownerInputRequestSchema,type OwnerInputRequest} from "./contracts";

/** Shared non-writing resolution contract. The owner chooses only server-issued
 * options, or supplies a bounded new statement. No domain mutation is allowed. */
export const OWNER_RESOLUTION_ID="platform.owner_input.resolve.v1";
export const OWNER_RESOLUTION_FIELD="owner.clarification";

export function prepareOwnerResolution(raw:unknown,answer:string):
  {answer:string;label:string}|null{
  const parsed=ownerInputRequestSchema.safeParse(raw);
  if(!parsed.success)return null;
  const request=parsed.data;
  if(request.mode!=="resolve"||
    request.writeCapabilityId!==OWNER_RESOLUTION_ID||
    request.fieldId!==OWNER_RESOLUTION_FIELD)return null;
  // Applies to BOTH free-text and option alternatives. UUID-shaped answers
  // identify records, never a genuine requested price or calendar value.
  const trimmed=answer.trim();
  if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(trimmed)&&
    (request.input.kind!=="options"||!request.input.options.some(o=>o.id===trimmed)))
    return null;
  if(request.input.kind==="options"){
    const matches=request.input.options.filter(o=>o.id===answer);
    if(matches.length===1)return {answer,label:matches[0].label.en};
    // "Answer another way" is a genuine owner-authored clarification, not a
    // selected product. Never reinterpret an unissued UUID as a free-text choice.
    const alternative=answer.trim();
    return alternative&&alternative.length<=200&&
      !request.input.options.some(option=>Object.values(option.label).includes(alternative))&&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(alternative)?
      {answer:alternative,label:alternative}:null;
  }
  const value=answer.trim();
  return value&&value.length<=200?{answer:value,label:value}:null;
}

export function ownerResolutionRequest(input:{
  question:OwnerInputRequest["question"];
  input:OwnerInputRequest["input"];
  context?:Record<string,string>;
}):OwnerInputRequest{
  return ownerInputRequestSchema.parse({
    mode:"resolve",fieldId:OWNER_RESOLUTION_FIELD,
    writeCapabilityId:OWNER_RESOLUTION_ID,
    writeContext:input.context??{},question:input.question,input:input.input,
  });
}

/** Only free-text corrections are owner-authored statements.
 * Selected option IDs are separate server-verified selector context; their
 * display labels (including prices) cannot authorize hypothetical inputs. */
export function resumeOwnerResolution(original:string,raw:unknown,answer:string):
  {originalText:string;ownerStatement:string|null;selectedProductId:string|null}|null{
  const prepared=prepareOwnerResolution(raw,answer);
  if(!prepared)return null;
  const request=ownerInputRequestSchema.parse(raw);
  const selected=request.input.kind==="options"&&
    request.input.options.some(option=>option.id===prepared.answer);
  return {originalText:original,
    ownerStatement:selected?null:prepared.answer,
    selectedProductId:selected?prepared.answer:null};
}
