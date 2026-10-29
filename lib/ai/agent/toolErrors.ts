import {readableSource} from "@/lib/ownerFacts/questions";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
/** Model-safe, typed tool failures. Never leak driver, SQL or authentication details. */
export const toolErrorCodes=[
  "unauthorized","scope_mismatch","not_found","inactive","unchanged","conflict",
  "validation","not_supported","write_failed","deadline_exceeded","internal",
] as const;
export type ToolErrorCode=(typeof toolErrorCodes)[number];
export class ToolError extends Error {
  constructor(public readonly code:ToolErrorCode,reason?:string){
    super(reason??code);this.name="ToolError";
  }
}
/** Unknown errors must never expose exception messages to the model. */
export function safeToolError(error:unknown,deadline=false,
 context?:{source:string;locale:"en"|"es"|"ar";period?:string}):{code:ToolErrorCode;reason:string;what:string;period:string}{
  const code:ToolErrorCode=deadline?"deadline_exceeded":error instanceof ToolError?error.code:"internal";
  const locale=context?.locale??"en";
  const copy={en,es,ar}[locale].OwnerQuestions;
  const what=readableSource(context?.source??"generic",locale);
  const period=context?.period??copy.period;
  return {code,what,period,reason:copy.error.replace("{source}",what).replace("{period}",period)};
}
export function toolErrorResult(source:string,error:unknown,deadline=false,
 locale:"en"|"es"|"ar"="en",period?:{from:string;to:string}){
  const mapped=safeToolError(error,deadline,{source,locale,
    period:period?period.from+" – "+period.to:undefined});
  return {source,period:period??null,missing:[mapped.code],error:mapped.code,
    reason:mapped.reason,what:mapped.what};
}
