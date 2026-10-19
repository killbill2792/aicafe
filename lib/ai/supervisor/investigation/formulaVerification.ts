/** Independent verification for a model-declared "show your work" formula
 * (docs §4b/§5). We never trust the model's own claimed result: every
 * variable's source is independently resolved (an exact owner-message quote,
 * or a real observation field, never a value the model merely asserts), the
 * formula is evaluated ourselves through the closed-grammar evaluator, and
 * the recomputed value is compared against what the paragraph's prose
 * claimed. Anything that doesn't check out is reported as a specific,
 * narrow failure -- never escalated into discarding more than the one
 * number it concerns (§3's core invariant). */
import {rat,times,type Rat} from "@/lib/calc/scenarioExpression";
import {evaluateFormulaScaled,formulaLiterals,formulaVariableNames,type FormulaRejectionReason,
  type ArithmeticUnit} from "@/lib/calc/formulaExpression";
import type {Observation,Locale} from "./evidence";
import type {FormulaEntry} from "./protocol";

export type FormulaVerificationFailure=
  |{reason:"grammar";detail:FormulaRejectionReason}
  |{reason:"source_not_found";variable:string}
  |{reason:"source_unverifiable";variable:string}
  |{reason:"ungrounded_literal"}
  |{reason:"unused_variable";variable:string}
  |{reason:"requires_registered_calculator"}
  |{reason:"incompatible_units"}
  |{reason:"incompatible_periods"}
  |{reason:"unparseable_claim"}
  |{reason:"sub_cent_precision"}
  |{reason:"result_mismatch";computed:number;claimed:number};
export type FormulaVerificationResult={ok:true;value:number}|{ok:false;failure:FormulaVerificationFailure};

const POINTER=/^(r\d+):([a-zA-Z0-9_.]+)$/u;
const VARIABLE_NAME=/^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/u;

/** Unicode decimal-digit blocks this project's supported locales (en/es/ar)
 * can actually produce or receive -- Arabic-Indic and Extended Arabic-Indic
 * (Persian). Each Unicode "Nd" digit block is guaranteed to hold 0-9 in
 * contiguous order, so a block's own start code point is enough to map any
 * of its digits back to ASCII. An unsupported script's digit is left as-is
 * and will simply fail to parse below (never silently misread). */
const DIGIT_BLOCK_STARTS:readonly number[]=[0x0660,0x06f0];
export function normalizeDigits(text:string):string{
  return text.replace(/\p{Nd}/gu,(ch)=>{
    const code=ch.codePointAt(0)!;
    for(const start of DIGIT_BLOCK_STARTS)
      if(code>=start&&code<=start+9)return String(code-start);
    return ch;
  });
}
/** Strips currency/percent/grouping decoration, keeping an exact numeric
 * snippet (sign, digits, at most one decimal point) -- or null if what
 * remains is not a single plain number. Never does unit conversion: a "%"
 * suffix is decoration only, the digits before it are used as written.
 *
 * Locale-aware (Codex finding): `es` writes the DECIMAL separator as "," and
 * groups thousands with "." (e.g. "1.610,25"); `en`/`ar` do the reverse
 * (e.g. "1,610.25", confirmed via this project's own `Intl.NumberFormat`
 * output for each locale). Blindly stripping every comma -- as before --
 * read an es owner's "1,61" (one dollar sixty-one) as the integer 161, a
 * 100x error that could let a model's declared source silently pass
 * verification against the wrong value. */
function parseNumericSnippet(text:string,locale:Locale):{rat:Rat;decimals:number}|null{
  const subunit=/(?:\bcents?\b|\bcentavos?\b|سنتات|سنت)/iu.test(text);
  const stripped=normalizeDigits(text).replace(/[−﹣－]/gu,"-").replace(/٬/gu,"").replace(/٫/gu,locale==="es"?",":".").replace(/[%٪$€£¥\s]/gu,"").replace(/(?:dollars?|d[oó]lares?|usd|cents?|centavos?|دولارات|دولارًا|دولار|سنتات|سنت)/giu,"");
  const cleaned=locale==="es"
    ?(/^[-]?\./u.test(stripped)?stripped:stripped.replace(/\./gu,"").replace(",","."))
    :stripped.replace(/,/gu,"");
  const match=/^(-?)(\d*)(?:\.(\d+))?$/u.exec(cleaned);
  if(!match||(!match[2]&&!match[3]))return null;
  const [,sign,whole,frac=""]=match;
  const n=BigInt((whole||"0")+frac)*(sign==="-"?BigInt(-1):BigInt(1));
  const decimals=frac.length+(subunit?2:0);
  const d=BigInt(10)**BigInt(decimals);
  return {rat:rat(n,d),decimals};
}
// `v.toString()` is plain JS number formatting -- always period-decimal,
// never locale text, never grouped -- so this must NEVER go through
// `parseNumericSnippet`'s locale-aware cleanup (an es-locale caller would
// wrongly strip its only "." as a thousands-grouping character).
function numberToRat(v:number):Rat|null{
  if(!Number.isFinite(v))return null;
  if(Number.isInteger(v))return rat(BigInt(v));
  const match=/^(-?)(\d+)\.(\d+)$/u.exec(v.toString());
  if(!match)return null;
  const [,sign,whole,frac]=match;
  const n=BigInt(whole+frac)*(sign==="-"?BigInt(-1):BigInt(1));
  const d=BigInt(10)**BigInt(frac.length);
  return rat(n,d);
}
function ratToNumber(r:Rat):number{
  return Number(r.n)/Number(r.d);
}
/** A deliberately coarse classification of an owner-quoted span's own
 * decoration (reused verbatim as this formula's per-variable unit -- see
 * `ArithmeticUnit`). Never does unit CONVERSION, only recognition, mirroring
 * `parseNumericSnippet`'s own "decoration only" rule. */
function moneyCurrency(text:string):string{
  if(/€/u.test(text))return "EUR";
  if(/£/u.test(text))return "GBP";
  if(/¥/u.test(text))return "JPY";
  return classifyOwnerUnit(text)==="money"?"USD":"";
}
function classifyOwnerUnit(text:string):ArithmeticUnit{
  if(/[%٪]/u.test(text))return "percent";
  if(/[$€£¥]|\b(?:dollars?|d[oó]lares?|usd|cents?|centavos?)\b|دولارات|دولار|سنتات|سنت/iu.test(text))return "money";
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
 * no such span exists.
 *
 * Generated echoes may omit a unit, but cannot add one. Numeric formula
 * source lookup also tolerates source-side decoration; resolution still
 * takes units exclusively from the owner's matched span. Numeric boundaries support
 * Unicode letters/digits; signs remain attached to genuine negatives. */
// Shared with claim rendering so units cannot fall outside the checked span.
export const NUMERIC_SPAN=String.raw`(?<![\p{L}\p{N}])(?:[-−﹣－]\s*)?(?:[$€£¥]\s*)?(?:[-−﹣－]\s*)?(?:\p{Nd}(?:[,.٫٬]?\p{Nd})*|[.,٫]\p{Nd}+)(?:\s*(?:[%٪]|(?:dollars?|d[oó]lares?|usd|cents?|centavos?|دولارات|دولارًا|دولار|سنتات|سنت)(?!\p{L})))?(?![\p{L}\p{N}])`;
/** Dates and clock times are indivisible claims. Checking each digit group
 * as a separate owner echo can authorize a date/time the owner never gave.
 * Use the same grammar for both the owner's sources and model output. */
export const STRUCTURED_TEMPORAL_SPAN=String.raw`(?<![\p{L}\p{N}])(?:\p{Nd}{4}[-/]\p{Nd}{1,2}[-/]\p{Nd}{1,2}(?:[Tt\s]\p{Nd}{1,2}:\p{Nd}{2}(?::\p{Nd}{2})?(?:Z|[+-]\p{Nd}{2}:\p{Nd}{2}|\s*[aApP]\.?[mM]\.?)?)?|\p{Nd}{1,2}[-/]\p{Nd}{1,2}[-/]\p{Nd}{2,4}|\p{Nd}{1,2}\.\p{Nd}{1,2}\.\p{Nd}{2,4}|\p{Nd}{4}[-/]\p{Nd}{1,2}(?![-/]\p{Nd})|\p{Nd}{1,2}/\p{Nd}{1,2}|\p{Nd}{1,2}:\p{Nd}{2}(?::\p{Nd}{2})?(?:\s*[aApP]\.?[mM]\.?)?)(?![\p{L}\p{N}])`;
const TEMPORAL_SPANS=new RegExp(STRUCTURED_TEMPORAL_SPAN,"giu");
const COMPLETE_TEMPORAL_SPAN=new RegExp("^(?:"+STRUCTURED_TEMPORAL_SPAN+")$","iu");
export function isStructuredTemporalSpan(text:string):boolean{
  return COMPLETE_TEMPORAL_SPAN.test(text);
}
export function findOwnerTemporalSpan(ownerText:string,claim:string):string|null{
  const value=normalizeDigits(claim).toLocaleLowerCase();
  for(const found of ownerText.matchAll(TEMPORAL_SPANS))
    if(normalizeDigits(found[0]).toLocaleLowerCase()===value)return found[0];
  return null;
}
const OWNER_NUMERIC_SPAN=new RegExp(NUMERIC_SPAN,"giu");
const WORD_CHAR=/[\p{L}\p{N}]/u;
export function findOwnerQuotedSpan(ownerText:string,source:string,locale:Locale,
  options?:{numericSourceOnly?:boolean}):string|null{
  const sourceParsed=parseNumericSnippet(source.trim(),locale);
  if(!sourceParsed)return null;
  const temporalRanges=[...ownerText.matchAll(TEMPORAL_SPANS)].map(m=>({start:m.index,end:m.index+m[0].length}));
  for(const match of ownerText.matchAll(OWNER_NUMERIC_SPAN)){
    const text=match[0],start=match.index,end=start+text.length;
    // Do not treat an individual year, month, day, hour, or minute as
    // an independently authored owner number.
    if(temporalRanges.some(span=>start<span.end&&end>span.start))continue;
    const before=ownerText[start-1]??"",after=ownerText[end]??"";
    if((before&&WORD_CHAR.test(before))||(after&&WORD_CHAR.test(after)))continue;
    const candidate=parseNumericSnippet(text,locale);
    const sourceUnit=classifyOwnerUnit(source),candidateUnit=classifyOwnerUnit(text);
    if(sourceUnit!=="scalar"&&sourceUnit!==candidateUnit&&
      !(options?.numericSourceOnly&&candidateUnit==="scalar"))continue;
    if(sourceUnit==="money"&&candidateUnit==="money"&&moneyCurrency(source)!==moneyCurrency(text))continue;
    if(candidate&&candidate.rat.n===sourceParsed.rat.n&&candidate.rat.d===sourceParsed.rat.d)return text;
  }
  return null;
}
const isRecord=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
/** Preserve registered calendar selectors across flat and nested readers.
 * A week and a financial range are distinct scopes, never silently equal. */
export function resolvedPeriod(input:unknown):string{
  if(!isRecord(input))return "";
  const scopes=[input,...(isRecord(input.request)?[input.request]:[])];
  const selectors=scopes.flatMap(scope=>[
    ...(isRecord(scope.period)?["period:"+JSON.stringify(Object.fromEntries(Object.entries(scope.period).sort(([a],[b])=>a.localeCompare(b))))]:[]),
    ...(typeof scope.week==="string"?["week:"+scope.week]:[]),
  ]);
  return [...new Set(selectors)].sort().join("|");
}
/** Carry authoritative temporal scope through derived results. Dataset
 * analysis stores its source-read ID rather than copying the original dates
 * into its own input. Never interpret missing, cyclic or incompatible
 * lineage as an unscoped numerical fact. */
export function observationPeriod(observation:Observation,observations:readonly Observation[],
  seen:ReadonlySet<string>=new Set()):string|null{
  if(seen.has(observation.id))return null;
  const visited=new Set(seen);visited.add(observation.id);
  const periods=new Set<string>();
  const own=resolvedPeriod(observation.input);
  if(own)periods.add(own);
  for(const inherited of observation.sourcePeriods??[])if(inherited)periods.add(inherited);
  const result=observation.result;
  const derived=isRecord(result.value)?result.value:null;
  const parentId=typeof derived?.sourceReadId==="string"?derived.sourceReadId:
    typeof result.sourceReadId==="string"?result.sourceReadId:null;
  const ids=new Set<string>();
  if(parentId)ids.add(parentId);
  if(Array.isArray(result.sourceHandles))for(const handle of result.sourceHandles){
    if(typeof handle!=="string")continue;
    const dataset=/^dataset:(r\d+):/u.exec(handle);
    if(dataset)ids.add(dataset[1]);
  }
  for(const id of ids){
    const parent=observations.find(o=>o.id===id);
    if(!parent)return null;
    const period=observationPeriod(parent,observations,visited);
    if(period===null)return null;
    if(period)periods.add(period);
  }
  return periods.size>1?null:([...periods][0]??"");
}
/** Resolve one declared variable's value, unit AND source period from its
 * OWN independent source, never from the model's claimed `value` field. A
 * pointer resolves against a real observation's recorded raw field (its
 * unit taken from the same money/percent classification `observationDisplay`
 * already computed); anything else must be a complete, token-bounded excerpt
 * of the owner's own message text (its unit taken from that matched span's
 * own decoration. A unit added only in a model declaration is never
 * evidence that the owner's undecorated number had that unit). */
function resolveVariable(source:string,observations:readonly Observation[],ownerText:string,locale:Locale):
  {value:Rat;unit:ArithmeticUnit;period:string;currency:string}|null{
  const byId=new Map(observations.map(o=>[o.id,o] as const));
  const pointer=POINTER.exec(source);
  if(pointer){
    const [,id,path]=pointer;
    const observation=byId.get(id);
    if(!observation||observation.result.status==="unavailable")return null;
    const raw=observation.displayRaw?.[path];
    if(typeof raw!=="number")return null;
    const kind=observation.displayKind?.[path];
    const period=observationPeriod(observation,observations);
    if(period===null)return null;
    // Money is stored as integer CENTS and percent as integer BASIS POINTS
    // everywhere in this project (CLAUDE.md rule #1; observationDisplay's
    // own raw[] convention) -- but an owner-quoted money/percent source is
    // always written in human-scale dollars/percent-points in prose (the
    // owner never types "300" meaning $3.00). Normalizing a pointer-sourced
    // money/percent value to that SAME human scale here, at resolution,
    // keeps every variable of a given unit on one consistent scale before
    // arithmetic ever runs. Without this, "price + extra" could combine a
    // raw-cents pointer (300) with a dollar-scale owner quote (2) under the
    // same coarse "money" tag -- and since we always recompute from the
    // SAME scale-confused inputs the model used, our own verification would
    // silently agree with the model's wrong total (Codex finding).
    if(kind==="money"||kind==="percent"){
      if(!Number.isInteger(raw))return null;
      return {value:rat(BigInt(raw),BigInt(100)),unit:kind,period,currency:kind==="money"?"USD":""};
    }
    const value=numberToRat(raw);
    if(!value)return null;
    return {value,unit:"scalar",period,currency:""};
  }
  if(!source)return null;
  const matchedSpan=findOwnerQuotedSpan(ownerText,source,locale,{numericSourceOnly:true});
  if(matchedSpan===null)return null;
  const parsed=parseNumericSnippet(source,locale);
  if(!parsed)return null;
  const spanUnit=classifyOwnerUnit(matchedSpan);
  return {value:parsed.rat,unit:spanUnit,period:"",
    currency:moneyCurrency(matchedSpan)};
}
export function verifyFormulaEntry(entry:FormulaEntry,ownerText:string,
  observations:readonly Observation[],locale:Locale):FormulaVerificationResult{
  // Reject any bare numeric literal in the formula itself (Codex finding):
  // "price * 999" with only `price` grounded would otherwise let an
  // entirely model-invented "999" multiplier pass, since the formula still
  // evaluates and a declared variable is still independently resolved --
  // only the literal is never checked against anything real. Every NUMBER
  // the formula uses must be a named, independently-resolved variable.
  const literals=formulaLiterals(entry.formula);
  if(literals===null)return {ok:false,failure:{reason:"grammar",detail:"unknown_character"}};
  if(literals.length>0)return {ok:false,failure:{reason:"ungrounded_literal"}};
  const usedNames=new Set(formulaVariableNames(entry.formula));
  const resolved=new Map<string,{value:Rat;unit:ArithmeticUnit}>();
  const periods=new Set<string>();
  const currencies=new Set<string>();
  let hasOwnerQuote=false;
  for(const [name,declaration] of Object.entries(entry.variables)){
    if(!usedNames.has(name))return {ok:false,failure:{reason:"unused_variable",variable:name}};
    if(!VARIABLE_NAME.test(name))return {ok:false,failure:{reason:"source_unverifiable",variable:name}};
    const resolvedVariable=resolveVariable(declaration.source,observations,ownerText,locale);
    if(resolvedVariable===null){
      const pointer=POINTER.test(declaration.source);
      return {ok:false,failure:{reason:pointer?"source_not_found":"source_unverifiable",variable:name}};
    }
    if(!POINTER.test(declaration.source))hasOwnerQuote=true;
    resolved.set(name,resolvedVariable);
    if(resolvedVariable.period)periods.add(resolvedVariable.period);
    if(resolvedVariable.currency)currencies.add(resolvedVariable.currency);
  }
  if(currencies.size>1)return {ok:false,failure:{reason:"incompatible_units"}};
  // A numeric owner quote does not establish its temporal scope. Never
  // silently combine it with dated data, even if only one pointer is used.
  if(periods.size>1||(hasOwnerQuote&&periods.size>0))
    return {ok:false,failure:{reason:"incompatible_periods"}};
  // One combined walk (Codex finding): computes the value AND propagates
  // units together, so a percentage used as a multiplicative RATE against
  // money ("$20 * 10%") is correctly scaled by /100 -- something evaluating
  // value and units as two independent passes could never do, since
  // neither pass alone sees both a node's value and its sibling's unit.
  // Still rejects, as an ordinary verification failure never a thrown
  // error, any formula combining incompatible dimensions (Codex finding
  // #1, e.g. a unit count added to a dollar amount) even when the
  // resulting NUMBER happens to match the claim.
  const evaluated=evaluateFormulaScaled(entry.formula,resolved);
  if(!evaluated.ok){
    if(evaluated.reason==="incompatible_units")return {ok:false,failure:{reason:"incompatible_units"}};
    return {ok:false,failure:{reason:"grammar",detail:evaluated.reason}};
  }
  // Bare quantities carry no dimension in this declaration format. Their
  // arithmetic must use the registered calculator's typed operands. Also
  // require an explicit result unit so "5 employees" cannot reuse a money
  // result merely because the visible numeric core is identical.
  const claimUnit=classifyOwnerUnit(entry.claim);
  if([...resolved.values()].some(v=>v.unit==="scalar")||evaluated.unit==="scalar"||claimUnit==="scalar")
    return {ok:false,failure:{reason:"requires_registered_calculator"}};
  if(claimUnit!==evaluated.unit)
    return {ok:false,failure:{reason:"incompatible_units"}};
  if(claimUnit==="money"&&currencies.size>0&&!currencies.has(moneyCurrency(entry.claim)))
    return {ok:false,failure:{reason:"incompatible_units"}};
  const claimed=parseNumericSnippet(entry.claim,locale);
  if(!claimed)return {ok:false,failure:{reason:"unparseable_claim"}};
  const computedNumber=ratToNumber(evaluated.value);
  const claimedNumber=ratToNumber(claimed.rat);
  const tolerance=0.5*Math.pow(10,-claimed.decimals)+1e-9;
  if(Math.abs(computedNumber-claimedNumber)>tolerance)
    return {ok:false,failure:{reason:"result_mismatch",computed:computedNumber,claimed:claimedNumber}};
  // Cent-precision check (Codex finding): money is integer cents everywhere
  // in this project (CLAUDE.md rule #1) -- "$9.67 / 2" recomputes EXACTLY to
  // 4.835, which could otherwise verify a claim written with that same
  // sub-cent precision even though no real dollar amount is ever worth a
  // fraction of a cent. Checked on the independently-RECOMPUTED rational
  // value (exact, never float-rounded), not by counting the claim text's
  // own decimal digits -- a claim written as "$4.830" is a perfectly valid
  // whole-cent amount (483 cents) despite its trailing zero.
  if(evaluated.unit==="money"){
    const cents=times(evaluated.value,rat(BigInt(100)));
    if(cents.d!==BigInt(1))return {ok:false,failure:{reason:"sub_cent_precision"}};
  }
  return {ok:true,value:computedNumber};
}

/** Call only after verification succeeded; every source has then resolved. */
export function formulaObservationIds(entry:FormulaEntry):string[]{
  return [...new Set(Object.values(entry.variables).flatMap(v=>{
    const pointer=POINTER.exec(v.source);
    return pointer?[pointer[1]]:[];
  }))];
}
