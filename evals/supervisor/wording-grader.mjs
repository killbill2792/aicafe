/**
 * Optional wording-only evaluation. GitHub Models' inference API was retired
 * on 2026-07-30, so this cannot make a free GitHub Models request in 2026.
 * It deliberately cannot fall back to any billable model or other credential.
 *
 * Numeric, date, identity, completeness and unsupported-fact assertions run
 * earlier in Promptfoo and are never skipped.
 */
import {appendFileSync} from "node:fs";
const checks=[
  "labor-missing: clear explanation of unavailable recorded wages",
  "best-margin: concise explanation of evidence without fabricated claims",
];
const notice="SKIP: "+checks.length+" wording-only AI-grader checks — GitHub Models "+
  "inference retired 2026-07-30; no free GitHub Models API is available. "+
  "All deterministic Supervisor factual assertions still run and must pass.";
console.log(notice);
for(const check of checks)console.log("  skipped: "+check);
if(process.env.GITHUB_ACTIONS==="true")console.log("::notice::"+notice);
if(process.env.GITHUB_STEP_SUMMARY){
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    "\n### Optional wording grader\n\n"+notice+"\n\n"+
    checks.map(x=>"- Skipped: "+x).join("\n")+"\n");
}
