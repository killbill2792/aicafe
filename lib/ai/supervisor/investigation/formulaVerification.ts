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
import {evaluateFormula,evaluateFormulaUnits,type FormulaRejectionReason,
  type ArithmeticUnit} from "@/lib/calc/formulaExpression";
import type {Observation} from "./evidence";
import type {FormulaEntry} from "./protocol";

export type FormulaVerificationFailure=
  |{reason:"grammar";detail:FormulaRejectionReason}
  |{reason:"source_not_found";variable:string}
  |{reason:"source_unverifiable";variable:string}
  |{reason:"incompatible_units"}
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
/** A deliberately coarse classification of an owner-quoted span's own
 * decoration (reused verbatim as this formula's per-variable unit -- see
 * `ArithmeticUnit`). Never does unit CONVERSION, only recognition, mirroring
 * `parseNumericSnippet`'s own "decoration only" rule. */
function classifyOwnerUnit(text:string):ArithmeticUnit{
  if(/%/u.test(text))return "percent";
  if(/[$€£¥]|\b(?:dollars?|d[oó]lares?|usd|cents?|centavos?)\b/iu.test(text))return "money";
  return "scalar";
}
/** A complete, token-bounded numeric/currency/percent span in the owner's
 * message whose numeric VALUE equals the declared source's own value --
 * never a substring match (so a declared source of "10" must never match
 * inside an owner-written "100"), while still tolerating reasonable
 * formatting differences (currency symbol present on only one side,
 * thousands separators, equivalent decimal representations) by comparing
 * the already-normalized numeric cores rather than the raw text. Returns
 * the exact matched span (so its OWN decoration -- which may differ from
 * the declared source's -- can inform the unit classification), or null if
 * no such span exists. */
const OWNER_NUMERIC_SPAN=/[$€£¥]?\d[\d,]*(?:\.\d+)?%?/gu;
const WORD_CHAR=/[\p{L}\p{N}]/u;
function findOwnerQuotedSpan(ownerText:string,source:string):string|null{
  const sourceParsed=parseNumericSnippet(source.trim());
  if(!sourceParsed)return null;
  for(const match of ownerText.matchAll(OWNER_NUMERIC_SPAN)){
    const text=match[0],start=match.index,end=start+text.length;
    const before=ownerText[start-1]??"",after=ownerText[end]??"";
    if((before&&WORD_CHAR.test(before))||(after&&WORD_CHAR.test(after)))continue;
    const candidate=parseNumericSnippet(text);
    if(candidate&&candidate.rat.n===sourceParsed.rat.n&&candidate.rat.d===sourceParsed.rat.d)return text;
  }
  return null;
}
/** Resolve one declared variable's value AND unit from its OWN independent
 * source, never from the model's claimed `value` field. A pointer resolves
 * against a real observation's recorded raw field (its unit taken from the
 * same money/percent classification `observationDisplay` already computed);
 * anything else must be a complete, token-bounded excerpt of the owner's own
 * message text (its unit taken from that matched span's own decoration,
 * falling back to the declared source text's decoration only when the
 * matched span itself carries none -- e.g. the owner wrote "1.45" but the
 * source was declared as "$1.45"). */
function resolveVariable(source:string,observations:readonly Observation[],ownerText:string):
  {value:Rat;unit:ArithmeticUnit}|null{
  const byId=new Map(observations.map(o=>[o.id,o] as const));
  const pointer=POINTER.exec(source);
  if(pointer){
    const [,id,path]=pointer;
    const observation=byId.get(id);
    if(!observation||observation.result.status==="unavailable")return null;
    const raw=observation.displayRaw?.[path];
    if(typeof raw!=="number")return null;
    const value=numberToRat(raw);
    if(!value)return null;
    const kind=observation.displayKind?.[path];
    return {value,unit:kind==="money"?"money":kind==="percent"?"percent":"scalar"};
  }
  if(!source)return null;
  const matchedSpan=findOwnerQuotedSpan(ownerText,source);
  if(matchedSpan===null)return null;
  const parsed=parseNumericSnippet(source);
  if(!parsed)return null;
  const spanUnit=classifyOwnerUnit(matchedSpan);
  return {value:parsed.rat,unit:spanUnit!=="scalar"?spanUnit:classifyOwnerUnit(source)};
}
export function verifyFormulaEntry(entry:FormulaEntry,ownerText:string,
  observations:readonly Observation[]):FormulaVerificationResult{
  const resolved=new Map<string,Rat>();
  const units=new Map<string,ArithmeticUnit>();
  for(const [name,declaration] of Object.entries(entry.variables)){
    if(!VARIABLE_NAME.test(name))return {ok:false,failure:{reason:"source_unverifiable",variable:name}};
    const resolvedVariable=resolveVariable(declaration.source,observations,ownerText);
    if(resolvedVariable===null){
      const pointer=POINTER.test(declaration.source);
      return {ok:false,failure:{reason:pointer?"source_not_found":"source_unverifiable",variable:name}};
    }
    resolved.set(name,resolvedVariable.value);
    units.set(name,resolvedVariable.unit);
  }
  const evaluated=evaluateFormula(entry.formula,resolved);
  if(!evaluated.ok)return {ok:false,failure:{reason:"grammar",detail:evaluated.reason}};
  // Unit-compatibility check (Codex finding #1): reject -- as an ordinary
  // verification failure, never a thrown error -- any formula that combines
  // incompatible dimensions (e.g. a unit count added to a dollar amount),
  // even when the resulting NUMBER happens to match the claim.
  const unitCheck=evaluateFormulaUnits(entry.formula,units);
  if(!unitCheck.ok)return {ok:false,failure:{reason:"incompatible_units"}};
  const claimed=parseNumericSnippet(entry.claim);
  if(!claimed)return {ok:false,failure:{reason:"unparseable_claim"}};
  const computedNumber=ratToNumber(evaluated.value);
  const claimedNumber=ratToNumber(claimed.rat);
  const tolerance=0.5*Math.pow(10,-claimed.decimals)+1e-9;
  if(Math.abs(computedNumber-claimedNumber)>tolerance)
    return {ok:false,failure:{reason:"result_mismatch",computed:computedNumber,claimed:claimedNumber}};
  return {ok:true,value:computedNumber};
}
