import type {RuleViolation} from "./ruleChecks";
/** Stable rule keys are unique per observed timecard, even on overlapping scans. */
export function dedupeAlerts(violations:RuleViolation[]):RuleViolation[]{
 const seen=new Set<string>();
 return violations.filter(v=>{
  const key=v.timecardId+"|"+v.key;
  if(seen.has(key))return false;
  seen.add(key);return true;
 });
}
