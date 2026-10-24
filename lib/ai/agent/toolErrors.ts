/** Model-safe, typed tool failures. Never leak driver, SQL or authentication details. */
export const toolErrorCodes=[
  "unauthorized","scope_mismatch","not_found","inactive","unchanged","conflict",
  "validation","not_supported","write_failed","deadline_exceeded","internal",
] as const;
export type ToolErrorCode=(typeof toolErrorCodes)[number];
export const TOOL_REASONS:Record<ToolErrorCode,string>={
  unauthorized:"You must be signed in as this café's owner.",
  scope_mismatch:"Your selected café does not match the authorized conversation. Switch back to the correct café and retry.",
  not_found:"That item could not be found in your café. Choose an item from the current menu.",
  inactive:"That menu item is inactive. Select an active item.",
  unchanged:"The proposed value is the same as the current value. Choose a different price.",
  conflict:"The underlying information changed. Refresh the item and try again.",
  validation:"The supplied information is invalid. Please check the values.",
  not_supported:"This action is not supported here. Use the available owner controls instead.",
  write_failed:"The proposal could not be saved. Nothing was changed; please retry.",
  deadline_exceeded:"This request ran out of time. Nothing was changed; please retry.",
  internal:"Something went wrong while checking this request. Please retry.",
};
export class ToolError extends Error {
  constructor(public readonly code:ToolErrorCode,reason?:string){
    super(reason??TOOL_REASONS[code]);this.name="ToolError";
  }
}
/** Unknown errors must never expose exception messages to the model. */
export function safeToolError(error:unknown,deadline=false):{code:ToolErrorCode;reason:string}{
  const code:ToolErrorCode=deadline?"deadline_exceeded":error instanceof ToolError?error.code:"internal";
  return {code,reason:error instanceof ToolError?error.message:TOOL_REASONS[code]};
}
export function toolErrorResult(source:string,error:unknown,deadline=false){
  const {code,reason}=safeToolError(error,deadline);
  return {source,period:null,missing:[code],error:code,reason};
}
