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
  if(request.input.kind==="options"){
    const matches=request.input.options.filter(o=>o.id===answer);
    return matches.length===1?{answer,label:matches[0].label.en}:null;
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

/** The owner-resolved context is authoritative only as an OWNER STATEMENT,
 * not as proof of a selected entity. Domain readers still revalidate scope,
 * exact IDs, freshness and matches after the original question is resumed. */
export function resumeOwnerResolution(original:string,raw:unknown,answer:string):string|null{
  const prepared=prepareOwnerResolution(raw,answer);
  if(!prepared)return null;
  const request=ownerInputRequestSchema.parse(raw);
  const context=Object.entries(request.writeContext)
    .filter(([key])=>key==="productId"||key==="catalogRevision"||key==="domain")
    .map(([key,value])=>key+"="+value).join(", ");
  const isCatalogChoice=request.input.kind==="options"&&request.writeContext.domain==="menu";
  const note="Owner clarification: "+prepared.label+
    (isCatalogChoice?" (selected catalog productId="+prepared.answer+")":"")+
    (context?" ("+context+")":"");
  return (original.slice(0,3600)+"\n"+note).slice(0,4000);
}
