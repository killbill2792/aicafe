/** Independent verification for a model-declared "show your work" formula
 * (docs §4b/§5). We never trust the model's own claimed result: every
 * variable's source is independently resolved (an exact owner-message quote,
 * or a real observation field, never a value the model merely asserts), the
 * formula is evaluated ourselves through the closed-grammar evaluator, and
 * the recomputed value is compared against what the paragraph's prose
 * claimed. Anything that doesn't check out is reported as a specific,
 * narrow failure -- never escalated into discarding more than the one
 * number it concerns (§3's core invariant). */
import {rat,type Rat} from "@/lib/calc/scenarioExpression";
import {evaluateFormula,type FormulaRejectionReason} from "@/lib/calc/formulaExpression";
import type {Observation} from "./evidence";
import type {FormulaEntry} from "./protocol";

export type FormulaVerificationFailure=
  |{reason:"grammar";detail:FormulaRejectionReason}
  |{reason:"source_not_found";variable:string}
  |{reason:"source_unverifiable";variable:string}
  |{reason:"unparseable_claim"}
  |{reason:"result_mismatch";computed:number;claimed:number};
export type FormulaVerificationResult={ok:true;value:number}|{ok:false;failure:FormulaVerificationFailure};

const POINTER=/^(r\d+):([a-zA-Z0-9_.]+)$/u;
const VARIABLE_NAME=/^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/u;

/** Strips currency/percent/grouping decoration, keeping an exact numeric
 * snippet (sign, digits, at most one decimal point) -- or null if what
 * remains is not a single plain number. Never does unit conversion: a "%"
 * suffix is decoration only, the digits before it are used as written. */
function parseNumericSnippet(text:string):{rat:Rat;decimals:number}|null{
  const cleaned=text.replace(/[,%$€£¥\s]/gu,"");
  const match=/^(-?)(\d+)(?:\.(\d+))?$/u.exec(cleaned);
  if(!match)return null;
  const [,sign,whole,frac=""]=match;
  const n=BigInt(whole+frac)*(sign==="-"?BigInt(-1):BigInt(1));
  const d=BigInt(10)**BigInt(frac.length);
  return {rat:rat(n,d),decimals:frac.length};
}
function numberToRat(v:number):Rat|null{
  if(!Number.isFinite(v))return null;
  if(Number.isInteger(v))return rat(BigInt(v));
  const parsed=parseNumericSnippet(v.toString());
  return parsed?parsed.rat:null;
}
function ratToNumber(r:Rat):number{
  return Number(r.n)/Number(r.d);
}
/** Resolve one declared variable's value from its OWN independent source,
 * never from the model's claimed `value` field. A pointer resolves against
 * a real observation's recorded raw field; anything else must be an exact
 * excerpt of the owner's own message text. */
function resolveVariable(source:string,observations:readonly Observation[],ownerText:string):Rat|null{
  const byId=new Map(observations.map(o=>[o.id,o] as const));
  const pointer=POINTER.exec(source);
  if(pointer){
    const [,id,path]=pointer;
    const observation=byId.get(id);
    if(!observation||observation.result.status==="unavailable")return null;
    const raw=observation.displayRaw?.[path];
    return typeof raw==="number"?numberToRat(raw):null;
  }
  if(!source||!ownerText.includes(source))return null;
  const parsed=parseNumericSnippet(source);
  return parsed?parsed.rat:null;
}
export function verifyFormulaEntry(entry:FormulaEntry,ownerText:string,
  observations:readonly Observation[]):FormulaVerificationResult{
  const resolved=new Map<string,Rat>();
  for(const [name,declaration] of Object.entries(entry.variables)){
    if(!VARIABLE_NAME.test(name))return {ok:false,failure:{reason:"source_unverifiable",variable:name}};
    const value=resolveVariable(declaration.source,observations,ownerText);
    if(value===null){
      const pointer=POINTER.test(declaration.source);
      return {ok:false,failure:{reason:pointer?"source_not_found":"source_unverifiable",variable:name}};
    }
    resolved.set(name,value);
  }
  const evaluated=evaluateFormula(entry.formula,resolved);
  if(!evaluated.ok)return {ok:false,failure:{reason:"grammar",detail:evaluated.reason}};
  const claimed=parseNumericSnippet(entry.claim);
  if(!claimed)return {ok:false,failure:{reason:"unparseable_claim"}};
  const computedNumber=ratToNumber(evaluated.value);
  const claimedNumber=ratToNumber(claimed.rat);
  const tolerance=0.5*Math.pow(10,-claimed.decimals)+1e-9;
  if(Math.abs(computedNumber-claimedNumber)>tolerance)
    return {ok:false,failure:{reason:"result_mismatch",computed:computedNumber,claimed:claimedNumber}};
  return {ok:true,value:computedNumber};
}
