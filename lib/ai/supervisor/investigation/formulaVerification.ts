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
import {evaluateFormulaScaled,formulaLiterals,type FormulaRejectionReason,
  type ArithmeticUnit} from "@/lib/calc/formulaExpression";
import type {Observation,Locale} from "./evidence";
import type {FormulaEntry} from "./protocol";

export type FormulaVerificationFailure=
  |{reason:"grammar";detail:FormulaRejectionReason}
  |{reason:"source_not_found";variable:string}
  |{reason:"source_unverifiable";variable:string}
  |{reason:"ungrounded_literal"}
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
  const stripped=normalizeDigits(text).replace(/[%$€£¥\s]/gu,"");
  const cleaned=locale==="es"
    ?stripped.replace(/\./gu,"").replace(",",".")
    :stripped.replace(/,/gu,"");
  const match=/^(-?)(\d+)(?:\.(\d+))?$/u.exec(cleaned);
  if(!match)return null;
  const [,sign,whole,frac=""]=match;
  const n=BigInt(whole+frac)*(sign==="-"?BigInt(-1):BigInt(1));
  const d=BigInt(10)**BigInt(frac.length);
  return {rat:rat(n,d),decimals:frac.length};
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
 * no such span exists.
 *
 * Leading `-?` (Codex finding): without it, an owner-written "-$5" matched
 * only the unsigned "$5", so a model's declared positive "5" could wrongly
 * verify against what the owner actually stated as a negative figure (a
 * loss/decrease silently read as a gain). The sign is now part of the
 * match, so the word-boundary check below (on the character immediately
 * before the match) correctly covers it too, with no further change.
 * `(?:[,.]?\p{Nd})*` (not `[\p{Nd},]*(?:\.\p{Nd}+)?`): each repetition is
 * either a bare digit or a separator immediately followed by a digit, since
 * -- once locale decides which of "," and "." is the decimal separator --
 * either may legitimately appear anywhere in a grouped number (e.g. es
 * "1.234.567,89"), while a trailing separator with no digit after it (e.g.
 * ordinary end-of-sentence punctuation right after a digit, "...cost 0.")
 * is never consumed as part of the span. `parseNumericSnippet` alone
 * decides what a fully-captured span actually means.
 *
 * `(?<!\p{Nd})` guarding the leading `-?` (hardening the sign fix above):
 * without it, a plain hyphenated date or range the owner typed verbatim
 * (e.g. "2026-10-05", or "pages 10-5") would have its SECOND digit run
 * misread as negative -- the "-" there separates two numbers, it is not a
 * minus sign, and it is always immediately preceded by a digit in exactly
 * that case. A genuine negative figure ("cost -5 some months") never has a
 * digit immediately before its "-", so this guard never affects it. */
const OWNER_NUMERIC_SPAN=/(?<!\p{Nd})-?[$€£¥]?\p{Nd}(?:[,.]?\p{Nd})*%?/gu;
const WORD_CHAR=/[\p{L}\p{N}]/u;
export function findOwnerQuotedSpan(ownerText:string,source:string,locale:Locale):string|null{
  const sourceParsed=parseNumericSnippet(source.trim(),locale);
  if(!sourceParsed)return null;
  for(const match of ownerText.matchAll(OWNER_NUMERIC_SPAN)){
    const text=match[0],start=match.index,end=start+text.length;
    const before=ownerText[start-1]??"",after=ownerText[end]??"";
    if((before&&WORD_CHAR.test(before))||(after&&WORD_CHAR.test(after)))continue;
    const candidate=parseNumericSnippet(text,locale);
    if(candidate&&candidate.rat.n===sourceParsed.rat.n&&candidate.rat.d===sourceParsed.rat.d)return text;
  }
  return null;
}
const isRecord=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
/** The time-period scope of a pointer-sourced observation's own read input,
 * if it had one -- "" (never clashing with anything) for a periodless
 * capability or an owner-quoted value, which belongs to no specific data
 * period at all. Mirrors the exact extraction `detectConflictingFacts`
 * (runInvestigation.server.ts) already uses for the same `input.period`
 * shape, so two different period representations of the "same" scope are
 * never treated as different by one check and the same by the other. */
function resolvedPeriod(input:unknown):string{
  return isRecord(input)&&isRecord(input.period)?JSON.stringify(input.period):"";
}
/** Resolve one declared variable's value, unit AND source period from its
 * OWN independent source, never from the model's claimed `value` field. A
 * pointer resolves against a real observation's recorded raw field (its
 * unit taken from the same money/percent classification `observationDisplay`
 * already computed); anything else must be a complete, token-bounded excerpt
 * of the owner's own message text (its unit taken from that matched span's
 * own decoration, falling back to the declared source text's decoration
 * only when the matched span itself carries none -- e.g. the owner wrote
 * "1.45" but the source was declared as "$1.45"). */
function resolveVariable(source:string,observations:readonly Observation[],ownerText:string,locale:Locale):
  {value:Rat;unit:ArithmeticUnit;period:string}|null{
  const byId=new Map(observations.map(o=>[o.id,o] as const));
  const pointer=POINTER.exec(source);
  if(pointer){
    const [,id,path]=pointer;
    const observation=byId.get(id);
    if(!observation||observation.result.status==="unavailable")return null;
    const raw=observation.displayRaw?.[path];
    if(typeof raw!=="number")return null;
    const kind=observation.displayKind?.[path];
    const period=resolvedPeriod(observation.input);
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
      return {value:rat(BigInt(raw),BigInt(100)),unit:kind,period};
    }
    const value=numberToRat(raw);
    if(!value)return null;
    return {value,unit:"scalar",period};
  }
  if(!source)return null;
  const matchedSpan=findOwnerQuotedSpan(ownerText,source,locale);
  if(matchedSpan===null)return null;
  const parsed=parseNumericSnippet(source,locale);
  if(!parsed)return null;
  const spanUnit=classifyOwnerUnit(matchedSpan);
  return {value:parsed.rat,unit:spanUnit!=="scalar"?spanUnit:classifyOwnerUnit(source),period:""};
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
  const resolved=new Map<string,{value:Rat;unit:ArithmeticUnit}>();
  const periods=new Set<string>();
  for(const [name,declaration] of Object.entries(entry.variables)){
    if(!VARIABLE_NAME.test(name))return {ok:false,failure:{reason:"source_unverifiable",variable:name}};
    const resolvedVariable=resolveVariable(declaration.source,observations,ownerText,locale);
    if(resolvedVariable===null){
      const pointer=POINTER.test(declaration.source);
      return {ok:false,failure:{reason:pointer?"source_not_found":"source_unverifiable",variable:name}};
    }
    resolved.set(name,resolvedVariable);
    if(resolvedVariable.period)periods.add(resolvedVariable.period);
  }
  // Temporal-compatibility check (Codex finding): two pointer-sourced
  // variables from DIFFERENT, real data periods combined in one formula
  // (e.g. subtracting last month's costs from today's revenue) could
  // otherwise verify as "profit" just because both operands share the same
  // coarse money dimension -- the unit check has no notion of time at all.
  // A periodless value (an owner quote, or a periodless capability's
  // reading) never clashes with anything, since it belongs to no specific
  // data window; only two DIFFERENT real periods together are rejected.
  if(periods.size>1)return {ok:false,failure:{reason:"incompatible_periods"}};
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
  // Result-unit check (Codex finding): when the claim's own text is
  // EXPLICITLY decorated as money or percent (a "$"/"%" the model itself
  // chose to write), the computed formula's dimension must agree -- this is
  // what catches a scalar result (e.g. a drinks-count plus a shift-count)
  // dressed up as a money claim like "$5". Deliberately never the reverse: a
  // claim written as a bare, undecorated number is NOT rejected just because
  // the formula happens to compute a money/percent dimension -- the NUMBER
  // itself is always independently recomputed and compared below regardless
  // of this check, so an undecorated claim carries no fabrication risk here,
  // and rejecting it would reintroduce the exact "AI dropped a symbol, so we
  // failed a correct answer" failure mode this whole effort exists to fix.
  const claimUnit=classifyOwnerUnit(entry.claim);
  if(claimUnit!=="scalar"&&claimUnit!==evaluated.unit)
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
