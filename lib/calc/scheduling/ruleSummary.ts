import {minutesToParts} from "./ruleInputValues";

/** Do not expose an inactive schedule threshold as if it were an enforced rule. */
export function ruleThresholdStatus(enabled:boolean,afterMinutes:number):
  | {enabled:false}
  | {enabled:true;hours:number;minutes:number} {
 if(!enabled)return {enabled:false};
 return {enabled:true,...minutesToParts(afterMinutes)};
}
