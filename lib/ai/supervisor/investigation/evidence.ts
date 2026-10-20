import {presentInvestigatedTasks} from "./taskPresentation";
import {formatScenarioValue,formatScenarioAssumption} from "../p3/formatScenario";
import {unit as expressionUnit} from "../p3/expression";
import {registeredReadCautions} from "../p3/readEvidencePresentation";
import {createHash} from "node:crypto";
import type {EvidenceReference,GroundedSupervisorReply,SupervisorReplyBlock} from "@/lib/ai/conversations/contracts";
import type {InvestigationAnswer} from "./protocol";
import {verifyFormulaEntry,findOwnerQuotedSpan,findOwnerTemporalSpan,isStructuredTemporalSpan,formulaObservationIds,NUMERIC_SPAN,STRUCTURED_TEMPORAL_SPAN,type FormulaVerificationFailure} from "./formulaVerification";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
export type Locale="en"|"es"|"ar";
export type Observation={id:string;capabilityId:string;input:unknown;result:Record<string,unknown>;
  reference:EvidenceReference|null;requiresSnapshot?:boolean;sourceContract?:string;display:Record<string,string>;
  /** Only set for a path observationDisplay classified as money (cents) or a
   * percentage (basis points); used only to decide whether/how a cited number
   * also earns a boxed fact alongside the answer's sentence, never to invent
   * one. */
  displayKind?:Record<string,"money"|"percent">;displayRaw?:Record<string,number>;
  datasetFields?:unknown;calculation?:boolean;
  /** Source period keys are attached only by the trusted registered calculator dispatcher. */
  sourcePeriods?:readonly string[];}
export const investigationLabels=(locale:Locale)=>({en,es,ar}[locale].SupervisorInvestigation);
const isRecord=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const clean=(v:string)=>v.replace(/[\p{Cc}\p{Cf}]/gu," ").trim();
/** Format only trusted evaluated results, never the model's placeholder digits. */
function computedFormulaDisplay(value:number,claim:string,locale:Locale):string{
  if(/[%٪]/u.test(claim))return new Intl.NumberFormat(locale,{style:"percent",maximumFractionDigits:2}).format(value/100);
  const currency=/€/u.test(claim)?"EUR":/£/u.test(claim)?"GBP":/¥/u.test(claim)?"JPY":"USD";
  return new Intl.NumberFormat(locale,{style:"currency",currency}).format(value);
}
/** Token values come only from validated tool output. Numeric text, dates,
 * money and URLs cannot be introduced by the narration model. */
export function observationDisplay(result:Record<string,unknown>,locale:Locale):
  {display:Record<string,string>;kind:Record<string,"money"|"percent">;raw:Record<string,number>}{
  const display:Record<string,string>={};
  const kind:Record<string,"money"|"percent">={};
  const raw:Record<string,number>={};
  const labels=investigationLabels(locale);
  const walk=(v:unknown,path:string,depth:number)=>{
    if(Object.keys(display).length>=400||depth>7)return;
    const key=path.split(".").at(-1)??"";
    if(/^(?:id|.*Id|.*Ids|sourceRevision|contract|selectorContractId|capabilityId|reason|purpose|source|formula)$/u.test(key))return;
    if(v===null||v===undefined)return;
    if(typeof v==="number"&&Number.isFinite(v)){
      const money=/Cents$|_cents$/u.test(key)||key==="value"&&result.unit==="USD_cents";
      const parentUnit=isRecord(result.value)?result.value.unit:undefined;
      const datasetUnit=expressionUnit.safeParse(parentUnit);
      if(result.id==="platform.dataset.analysis"&&key==="value"&&datasetUnit.success){
        display[path]=formatScenarioValue(v,datasetUnit.data,locale);
        if(datasetUnit.data==="USD_cents"){kind[path]="money";raw[path]=v;}
        return;
      }
      if(/(?:Bps|BasisPoints)$/u.test(key)){
        display[path]=new Intl.NumberFormat(locale,{style:"percent",maximumFractionDigits:2}).format(v/10000);
        kind[path]="percent";raw[path]=v;
        return;
      }
      if(money||key==="value"&&parentUnit==="USD_cents"){
        display[path]=new Intl.NumberFormat(locale,{style:"currency",currency:"USD"}).format(v/100);
        kind[path]="money";raw[path]=v;
      }else{
        display[path]=new Intl.NumberFormat(locale,{maximumFractionDigits:6}).format(v);
        // Not money/percent (no `kind` set -- the boxed-fact decision elsewhere
        // still requires `kind`), but the exact raw value is still recorded so
        // the formula verifier (§4b) can resolve a plain numeric observation
        // pointer precisely, without re-parsing a locale-formatted string.
        raw[path]=v;
      }
    }else if(typeof v==="boolean")display[path]=v?labels.yes:labels.no;
    else if(typeof v==="string"){
      if(v.length>600||/^[a-f\d]{8}-[a-f\d-]{27,}$/iu.test(v))return;
      if(/https?:\/\/|www\./iu.test(v)){
        if(key!=="url"||result.id!=="public.research")return;
        try{if(new URL(v).protocol!=="https:")return;}catch{return;}
      }
      display[path]=clean(v);
    }else if(Array.isArray(v))v.slice(0,100).forEach((x,i)=>walk(x,path+"."+i,depth+1));
    else if(isRecord(v))for(const [k,x] of Object.entries(v))
      if(/^[a-zA-Z][a-zA-Z0-9_]*$/u.test(k))walk(x,path?path+"."+k:k,depth+1);
  };
  walk(result.value,"value",0);
  if(isRecord(result.query))walk(result.query,"query",0);
  if(isRecord(result.provenance)&&typeof result.provenance.asOf==="string")
    display["provenance.asOf"]=clean(result.provenance.asOf);
  if(result.capabilityId==="platform.scenario.expression.v1"&&Array.isArray(result.assumptions))
    result.assumptions.forEach((a,i)=>{if(typeof a==="string")display["assumptions."+i]=formatScenarioAssumption(a,locale);});
  return {display,kind,raw};
}
export function observationReference(businessId:string,asOf:string,capabilityId:string,result:unknown,inheritedSource?:EvidenceReference["source"]):EvidenceReference{
  const provenance=isRecord(result)&&isRecord(result.provenance)?result.provenance:null;
  const source:EvidenceReference["source"]=inheritedSource==="unverified_external"?inheritedSource:provenance?.sourceId==="public.search"&&
    provenance.canonicalReaderId==="public.brave.search"?"unverified_external":"cafe_state";
  return {source,identifier:"investigation:"+createHash("sha256")
    .update(JSON.stringify({businessId,asOf,capabilityId,result})).digest("hex").slice(0,32),asOf};
}
/** A single claim-level finding from `renderInvestigationAnswer`. Used ONLY
 * to build precise retry feedback (§5b/§6) and the final "I wasn't able to
 * confirm" summary (§7) -- never to decide whether to show the REST of the
 * answer, which the invariant in §3 already guarantees survives regardless. */
export type ClaimIssue=
  |{kind:"dropped_paragraph";paragraphIndex:number;
    reason:"hallucinated_citation"|"empty_citation_pull"|"invalid_token"|"uncited_evidence"|
      "citations_on_non_evidence"|"unrecognized_numeral";
    id?:string;path?:string;validIds?:string[]}
  |{kind:"unmatched_number";paragraphIndex:number;text:string;matchedObservation:{id:string;path:string}|null}
  |{kind:"formula_failed";paragraphIndex:number;text:string;failure:FormulaVerificationFailure}
  |{kind:"business_claim_uncited";paragraphIndex:number;text:string};
/** A number presented as a specific fact about THIS owner's business
 * ("your", "you're", "yours", "this café") must always resolve through a
 * real citation -- never through the owner-echo or formula paths below,
 * which are only for general/hypothetical numbers (§3's one non-negotiable
 * rule). English-pattern heuristic; the independent reviewer
 * (reviewInstructions) is the semantic backstop for other phrasings/locales. */
const BUSINESS_SPECIFIC=/\b(?:mi|mis|tu|tus|su|sus|nuestro|nuestra|nuestros|nuestras)\b|\byour\b|\byours\b|\bmy\b|\bour\b|\byou'?re\b|\bthis caf[ée](?![\p{L}\p{N}])|\b(?:mi|mis)\b|\b(?:tu|tus|su|sus|nuestro|nuestra|nuestros|nuestras|este|esta)\s+(?:ganancia|margen|ventas?|ingresos?|costos?|costes?|precios?|nómina|nomina|beneficios?|caf[ée]|cafeter[ií]a|negocio)(?![\p{L}\p{N}])|(?:ربحك|أرباحك|مبيعاتك|إيراداتك|تكاليفك|تكلفتك|أسعارك|سعرك|مقه[اى]ك|مقهاك|رواتبك|الربح\s+الخاص\s+بك)/iu;
/** When an echo omits the owner's explicit money/percent unit, accept it
 * only as a bare, sentence-terminated value. Allowing arbitrary trailing
 * words would license "5 new employees" from "$5"; enumerating quantity
 * nouns or adjective positions cannot be safe across en/es/ar. For a value
 * inside a larger phrase, cite the typed calculator or source instead. */
const IS_BARE_ECHO_END=/^\s*(?:$|[.,!?;:)\]}؟؛،])/u;
/** Untyped repetition of a typed amount is only safe without a preceding
 * quantity label or other business-specific qualifier. A small allowlist of
 * neutral introductory verbs avoids reinterpreting $5 as "employees: 5". */
const IS_NEUTRAL_ECHO_PREFIX=/^\s*(?:(?:consider|assume|suppose|imagine|use|take|considera|considere|supongamos|افترض|اعتبر)\s*)?$/iu;
const TYPED_AMOUNT=/[$€£¥%٪]|\b(?:dollars?|d[oó]lares?|usd|cents?|centavos?)\b|دولار|سنت/iu;
/** Finds an exact, already-produced observation display value matching a
 * freehand span the model wrote itself -- the §5b "cheap direct check"
 * done BEFORE any heavier formula/extraction verification. A match here
 * means the number is real but simply uncited, not fabricated. */
function findDirectObservationMatch(spanText:string,observations:readonly Observation[]):{id:string;path:string}|null{
  for(const o of observations)
    for(const [path,displayText] of Object.entries(o.display))
      if(displayText===spanText)return {id:o.id,path};
  return null;
}
/** Every double-brace citation token, PLUS every freehand URL/number/
 * currency/percent span -- matched in one pass so each is classified and
 * either kept or masked independently (§3's claim-level pass), never
 * discarding more than the one span/paragraph a problem actually concerns. */
// Use the same Unicode numeric/unit grammar as owner-source verification.
// Capturing visible currency words and percent signs inside the claim keeps
// the unit check effective in English, Spanish and Arabic alike.
const CLAIM_SPAN=new RegExp(String.raw`\{\{(r\d+):([a-zA-Z0-9_.]+)\}\}|https?:\/\/\S+|www\.\S+|${STRUCTURED_TEMPORAL_SPAN}|${NUMERIC_SPAN}`,"giu");
/** Recognize *only* explicitly declared, existing citation markers as prose
 * decoration. Unknown/mismatched markers stay in place and fail the numeric
 * guard, rather than silently authorizing invented references. */
export function stripDeclaredCitationDecorations(text:string,citations:readonly string[],
  known:ReadonlySet<string>):string{
  return text.replace(/〔(r\d+)〕|［(r\d+)］|\[(r\d+)\]/gu,
    (original:string,a:string|undefined,b:string|undefined,c:string|undefined)=>{
      const id=a??b??c;
      return id&&known.has(id)&&citations.includes(id)?"":original;
    }).replace(/\s{2,}/gu," ").trim();
}
export function renderInvestigationAnswer(answer:InvestigationAnswer,observations:readonly Observation[],locale:Locale,
  options?:{ownerText?:string}):
  {blocks:SupervisorReplyBlock[];evidence:EvidenceReference[];adviceOnly:boolean;hasComputedClaim:boolean;
    issues:ClaimIssue[];citedIds:string[]}|null{
  const byId=new Map(observations.map(o=>[o.id,o]));
  if(!["en","es","ar"].includes(locale))return null;
  const labels=investigationLabels(locale);
  const ownerText=options?.ownerText??"";
  const blocks:SupervisorReplyBlock[]=[],refs:EvidenceReference[]=[],issues:ClaimIssue[]=[];
  // Only citations on a paragraph that actually SURVIVED claim-level
  // rendering (Codex finding #4): a paragraph dropped for one hallucinated
  // citation must never let its OTHER, real citation leak a task card or a
  // caution into the final reply just because it was also named in the
  // original (pre-render) paragraph list.
  const survivingCitedIds=new Set<string>();
  let boxedCount=0;const boxedSignatures=new Set<string>();
  let adviceOnly=true,hasComputedClaim=false;
  answer.paragraphs.map(p=>({...p,text:stripDeclaredCitationDecorations(p.text,p.citations,new Set(byId.keys()))})).forEach((paragraph,paragraphIndex)=>{
    // Structural mismatches between a paragraph's self-reported kind and its
    // citations drop only THAT paragraph (§3's invariant), never the whole
    // answer.
    if(paragraph.kind!=="evidence"&&paragraph.citations.length){
      issues.push({kind:"dropped_paragraph",paragraphIndex,reason:"citations_on_non_evidence"});return;
    }
    if(paragraph.kind==="evidence"&&!paragraph.citations.length){
      issues.push({kind:"dropped_paragraph",paragraphIndex,reason:"uncited_evidence"});return;
    }
    // A citation to an id never produced this turn at all is hallucinated
    // even when the paragraph never tries to pull a value out of it via a
    // {{rN:path}} token -- a bare, untokenized citation list is still a
    // claim that this evidence exists and must resolve to something real.
    if(paragraph.kind==="evidence"){
      const hallucinated=paragraph.citations.find(citedId=>!byId.has(citedId));
      if(hallucinated){
        issues.push({kind:"dropped_paragraph",paragraphIndex,reason:"hallucinated_citation",
          id:hallucinated,validIds:[...byId.keys()]});
        return;
      }
    }
    // Fail closed against any numeral CLAIM_SPAN's own matching failed to
    // recognize as a span at all -- e.g. a script this regex's boundary
    // handling doesn't cover. Checked on a COPY with every real match
    // stripped out, so a legitimately-matched, soon-to-be-substituted span
    // is never mistaken for a leftover; only a numeral the regex never even
    // saw as a candidate trips this. Never silently let an unrecognized
    // numeral reach the owner merely because our pattern missed it.
    if(/\p{Nd}/u.test(paragraph.text.replace(CLAIM_SPAN,""))){
      issues.push({kind:"dropped_paragraph",paragraphIndex,reason:"unrecognized_numeral"});return;
    }
    let dropped=false,paragraphComputed=false;
    const formulaCitedIds=new Set<string>();
    const matched:{id:string;path:string}[]=[];
    const businessSpecific=BUSINESS_SPECIFIC.test(paragraph.text);
    const text=paragraph.text.replace(CLAIM_SPAN,(full:string,tokenId:string|undefined,tokenPath:string|undefined,matchOffset:number)=>{
      if(tokenId!==undefined&&tokenPath!==undefined){
        // §2: tell apart a citation to an id never produced this turn
        // (hallucinated) from a real id whose lookup came back with no
        // value (an empty pull, never fine to narrate a number out of) and
        // from a real, available field. A cited-but-unavailable observation
        // that is only NARRATED (no token pulling a value out of it) is
        // fine and never reaches this branch at all.
        if(!paragraph.citations.includes(tokenId)){
          dropped=true;issues.push({kind:"dropped_paragraph",paragraphIndex,reason:"invalid_token",id:tokenId});
          return full;
        }
        const observation=byId.get(tokenId);
        if(!observation){
          dropped=true;issues.push({kind:"dropped_paragraph",paragraphIndex,reason:"hallucinated_citation",
            id:tokenId,validIds:[...byId.keys()]});
          return full;
        }
        if(observation.result.status==="unavailable"){
          dropped=true;issues.push({kind:"dropped_paragraph",paragraphIndex,reason:"empty_citation_pull",
            id:tokenId,path:tokenPath});
          return full;
        }
        if(!Object.hasOwn(observation.display,tokenPath)){
          dropped=true;issues.push({kind:"dropped_paragraph",paragraphIndex,reason:"invalid_token",
            id:tokenId,path:tokenPath});
          return full;
        }
        matched.push({id:tokenId,path:tokenPath});
        return observation.display[tokenPath];
      }
      // A freehand URL never qualifies for the owner-echo/formula paths below.
      if(/^(?:https?:\/\/|www\.)/iu.test(full)){
        issues.push({kind:"unmatched_number",paragraphIndex,text:full,matchedObservation:null});
        return labels.unverifiedValue;
      }
      // The one non-negotiable rule: a specific claim about THIS owner's
      // business must resolve through a real citation, never echo/formula.
      if(businessSpecific){
        issues.push({kind:"business_claim_uncited",paragraphIndex,text:full});
        return labels.unverifiedValue;
      }
      // A date or clock time is a single claim, never a collection of
      // separately echoed numbers (e.g. 2026-10-19 != 2026-19-10).
      // Owner-source verification uses this same grammar to exclude every
      // individual date/time component from ordinary numeric echoes.
      if(isStructuredTemporalSpan(full)){
        if(findOwnerTemporalSpan(ownerText,full)!==null)return full;
        issues.push({kind:"unmatched_number",paragraphIndex,text:full,matchedObservation:null});
        return labels.unverifiedValue;
      }
      // §3: an exact echo of the owner's own words is not a new claim --
      // but it must be a COMPLETE numeric span of theirs, never a substring
      // match (so a freehand "10" must never pass just because an owner
      // message containing "100" happens to contain that digit sequence).
      // Shares the same boundary-aware, format-tolerant matching the
      // formula path (§4b) already uses, rather than a second, divergent
      // implementation of the same check.
      const quoted=findOwnerQuotedSpan(ownerText,full,locale);
       const preceding=paragraph.text.slice(0,matchOffset);
       const following=paragraph.text.slice(matchOffset+full.length);
       if(quoted!==null&&!(TYPED_AMOUNT.test(quoted)&&!TYPED_AMOUNT.test(full)&&
         (!IS_NEUTRAL_ECHO_PREFIX.test(preceding)||!IS_BARE_ECHO_END.test(following))))return full;
      // §4b: a verified formula entry whose claim matches this exact span.
      const formulaEntry=paragraph.formulas?.find(f=>f.claim===full);
      if(formulaEntry){
        const verified=verifyFormulaEntry(formulaEntry,ownerText,observations,locale);
        if(verified.ok){
          paragraphComputed=true;
          for(const id of formulaObservationIds(formulaEntry))formulaCitedIds.add(id);
          return computedFormulaDisplay(verified.value,full,locale);
        }
        issues.push({kind:"formula_failed",paragraphIndex,text:full,failure:verified.failure});
        return labels.unverifiedValue;
      }
      // Nothing backs this number: mask just this span (§3), after a cheap
      // direct check (§5b) against values already produced this turn.
      issues.push({kind:"unmatched_number",paragraphIndex,text:full,
        matchedObservation:findDirectObservationMatch(full,observations)});
      return labels.unverifiedValue;
    });
    if(dropped)return;
    // Defensive: a malformed token grammar (e.g. a stray bracket in the
    // path) that CLAIM_SPAN does not recognize as a token at all leaves its
    // literal "{{"/"}}" unresolved -- never leak that implementation syntax
    // to the owner. Drop this one paragraph rather than show it. (The
    // masking placeholder text itself legitimately contains "[" "]", so
    // only double-brace syntax is checked here, not brackets in general.)
    if(/\{\{|\}\}/u.test(text))return;
    const cleanedText=clean(text);
    if(!cleanedText||cleanedText.length>1200)return;
    if(paragraph.kind==="evidence"||formulaCitedIds.size>0)adviceOnly=false;
    hasComputedClaim ||= paragraphComputed;
    blocks.push({type:"text",text:cleanedText});
    // Every citation on a surviving paragraph earns its evidence reference,
    // not only one actually substituted via a {{rN:path}} token -- a
    // paragraph may cite a source purely to NARRATE it (e.g. "that task
    // needs your review") with no value pulled out of it at all.
    for(const id of new Set([...paragraph.citations,...formulaCitedIds])){
      survivingCitedIds.add(id);
      const o=byId.get(id);
      if(o?.reference&&!refs.some(r=>r.identifier===o.reference!.identifier))refs.push(o.reference);
    }
    // A boxed fact echoes a number already stated in the sentence just
    // pushed above -- immediately after it, never batched at the end, so a
    // multi-paragraph answer (revenue, then cost, then margin) keeps each
    // box next to the sentence it belongs to instead of an ambiguous pile.
    // Never introduces a value the sentence didn't already cite. Capped so
    // one answer never turns into a wall of boxes.
    if(paragraph.kind==="evidence")for(const {id,path} of matched){
      if(boxedCount>=4)break;
      const observation=byId.get(id);
      const kind=observation?.displayKind?.[path];
      const rawValue=observation?.displayRaw?.[path];
      if(!observation?.reference||!kind||typeof rawValue!=="number")continue;
      const signature=observation.reference.identifier+":"+path;
      if(boxedSignatures.has(signature))continue;
      boxedSignatures.add(signature);boxedCount++;
      blocks.push(kind==="money"
        ?{type:"metric",label:labels.factAmount,valueCents:rawValue,source:observation.reference}
        :{type:"percent",label:labels.factPercent,valueBps:rawValue,source:observation.reference});
    }
  });
  // §3: only fall back to "nothing to show" if literally nothing survived.
  if(!blocks.length)return null;
  return {blocks,evidence:refs,adviceOnly,hasComputedClaim,issues,citedIds:[...survivingCitedIds]};
}
/** A short, specific retry message (§5b/§6) naming the exact paragraph and
 * offending span/citation, built from the FIRST few claim issues found --
 * never a generic "fix your formatting" message when a precise one is
 * available. */
export function buildClaimFeedback(issues:readonly ClaimIssue[]):string{
  const describe=(issue:ClaimIssue):string=>{
    const at="Paragraph "+(issue.paragraphIndex+1)+": ";
    switch(issue.kind){
      case "dropped_paragraph":switch(issue.reason){
        case "hallucinated_citation":
          return at+"citation "+issue.id+" was never produced this turn. Valid ids are: "+
            (issue.validIds?.length?issue.validIds.join(", "):"none yet")+". Use one of those, or make a new lookup.";
        case "empty_citation_pull":
          return at+"the lookup for "+issue.id+" came back with no value (status unavailable). "+
            "Remove that token and either narrate that it is unavailable, or omit the claim.";
        case "invalid_token":
          return at+"the token for "+issue.id+" does not match a real supplied display field. "+
            "Use one of the exact display tokens already supplied for that id.";
        case "uncited_evidence":
          return at+"this is labeled evidence but cites nothing. Add a real citation or change its kind.";
        case "citations_on_non_evidence":
          return at+"advice/clarification paragraphs must not include citations. Remove them or change the kind.";
        case "unrecognized_numeral":
          return at+"this paragraph contains a numeral our checks could not recognize as a verifiable claim span. "+
            "Rewrite any number using plain digits, cite a real observation, or remove the claim.";
      }
      case "unmatched_number":
        return issue.matchedObservation
          ?at+"the number \""+issue.text+"\" exactly matches "+issue.matchedObservation.id+"'s "+
            issue.matchedObservation.path+" field. Cite it with the real display token instead of writing it freehand."
          :at+"the number \""+issue.text+"\" has no citation, exact owner quote, or independently verified formula. "+
            "For derived arithmetic CALL platform.scenario.expression.v1 with the supplied authorized operand handles, then cite its returned calculation. Otherwise provide a verifiable formula with sources or remove the number.";
      case "formula_failed":
        if(issue.failure.reason==="requires_registered_calculator")return at+
          "the quantity behind \""+issue.text+"\" requires typed quantity units. Call platform.scenario.expression.v1 with authorized operand handles, then cite its result.";
        if(issue.failure.reason==="result_mismatch")return at+
          "the claim \""+issue.text+"\" disagrees with independent arithmetic (computed "+
          issue.failure.computed+"). Call platform.scenario.expression.v1 with the authorized source handles and your intended operation. Use ONLY the returned result; otherwise remove the unsupported claim.";
        return at+"the formula behind \""+issue.text+"\" failed verification ("+issue.failure.reason+
          "). Call platform.scenario.expression.v1 with authorized operands, or correct the verifiable inputs and remove the unsupported number.";
      case "business_claim_uncited":
        return at+"\""+issue.text+"\" is phrased as a specific fact about the owner's café "+
          "without an observation citation. For arithmetic CALL platform.scenario.expression.v1 and cite the returned calculated observation; for factual numbers cite the actual source. Never assert a scenario as observed revenue.";
    }
  };
  return [...new Set(issues.slice(0,3).map(describe))].join(" ");
}
/** Last-resort text for when the investigation is about to give up with a
 * genuine model answer in hand that merely failed our mechanical display-
 * token formatting gate -- never thrown away silently just because the
 * model wrote `{{r1:value[0].priceCents}}` (a plausible alternate syntax)
 * instead of the one exact placeholder grammar the strict renderer accepts.
 * Strips every double-brace span outright (we have no validated display
 * value to trust there, so it must never reach the owner as literal
 * syntax), then rejects the whole candidate if any digit, currency/percent
 * symbol or URL remains anywhere in the surrounding prose: the independent
 * review the caller still runs is a semantic "is this plausible" check, not
 * a deterministic guarantee that a literal the model typed itself (a
 * misremembered "$5.25", a fabricated "$999") traces to real data, so a
 * raw number of the model's own making can never survive here -- only a
 * genuinely cited value that merely used the wrong token syntax, now masked
 * entirely rather than shown raw either way.
 * Deliberately narrower than a plain formatting check: "advice" and
 * "clarification" paragraphs carry no evidence requirement at all, and the
 * model's own self-reported kind is not proof of intent -- a false action
 * claim ("I published 2 schedules") mislabeled as a clarification would
 * otherwise sail through untouched by the no-raw-digit rule this function
 * does not re-apply. Only a paragraph of kind "evidence", whose every
 * citation resolves to a real, available observation, is ever eligible.
 * A real citation only proves the id exists, not that the surrounding
 * prose is actually supported by it or covers the owner's goal, so the
 * caller must still run this candidate through the same independent review
 * a grounded answer passes (never the one already failed by a negative
 * verdict from this exact answer -- that finding must never be
 * contradicted) before trusting it as a rescue. The returned citedIds let
 * the caller reapply the same publication-time
 * authorization/snapshot check the fully grounded path uses, since this
 * text can still describe real café data. */
export function renderUnverifiedAnswer(answer:InvestigationAnswer,observations:readonly Observation[],locale:Locale):
  {text:string;citedIds:string[]}|null{
  const byId=new Map(observations.map(o=>[o.id,o]));
  const citedIds=new Set<string>();
  for(const paragraph of answer.paragraphs){
    if(paragraph.kind!=="evidence")return null;
    if(!paragraph.citations.length)return null;
    for(const id of paragraph.citations){
      const observation=byId.get(id);
      if(!observation||observation.result.status==="unavailable")return null;
      citedIds.add(id);
    }
  }
  const labels=investigationLabels(locale);
  const text=answer.paragraphs
    // Any double-brace span, not only one matching the valid {{rN:path}}
    // grammar: a malformed or alternate-syntax token (e.g. a stray bracket
    // in the path) must never survive as literal implementation syntax in
    // owner-facing text just because it didn't match the strict pattern.
    .map(p=>clean(p.text.replace(/\{\{[^{}]*\}\}/gu,labels.unverifiedValue)))
    .filter(Boolean).join(" ");
  // The independent review the caller runs on this text is a semantic
  // check ("is this supported and complete"), never a deterministic
  // guarantee that every literal number/date/URL traces to validated data
  // -- a model-authored "$999" sitting outside any placeholder could read
  // as perfectly plausible and "supported" to that reviewer while tracing
  // to nothing real. Reject the whole rescue, exactly as the strict
  // renderer would, if anything numeric/currency/URL-like (or an
  // unresolved/unbalanced brace) remains after stripping every token.
  if(/[\p{N}$€£¥%{}]|https?:\/\/|www\./iu.test(text))return null;
  const cleaned=clean(text);
  return cleaned?{text:cleaned.slice(0,1100),citedIds:[...citedIds]}:null;
}
/** Mandatory per-citation cautions -- unverified public research, monetary
 * unavailability, estimated inputs, and any registered source's own
 * caution -- that must survive on EVERY reply citing these observations,
 * not only the fully grounded path. Shared with the unverified-answer
 * rescue so a citation to, say, a labor-law-caveated schedule read never
 * loses that caveat just because the surrounding prose failed rendering. */
export function citationCautionWarnings(cited:readonly Observation[],locale:Locale):SupervisorReplyBlock[]{
  const labels=investigationLabels(locale);
  const warnings:SupervisorReplyBlock[]=[];
  if(cited.some(o=>o.reference?.source==="unverified_external"))
    warnings.push({type:"warning",code:"SUPERVISOR_PUBLIC_RESEARCH",text:labels.research});
  if(cited.some(o=>isRecord(o.result.quality)&&Array.isArray(o.result.quality.missingInputs)&&
    o.result.quality.missingInputs.includes("monetary_fields_unavailable")))
    warnings.push({type:"warning",code:"SUPERVISOR_MONETARY_UNAVAILABLE",text:labels.financialUnavailable});
  if(cited.some(o=>{
    const q=o.result.quality;
    return isRecord(q)&&Array.isArray(q.estimatedInputs)&&q.estimatedInputs.length>0;
  }))warnings.push({type:"warning",code:"SUPERVISOR_ESTIMATED",text:labels.estimated});
  for(const caution of new Set(cited.flatMap(o=>registeredReadCautions(o.result,locale))))
    warnings.push({type:"warning",code:"SUPERVISOR_SOURCE_CAUTION",text:caution});
  return warnings;
}
/** The owner-facing trailing note for whatever survived masking (§3/§7):
 * names only that SOMETHING could not be confirmed, never the unverified
 * value itself, and never the internal reason (citation/token/formula) --
 * those are for the retry feedback (buildClaimFeedback) and debug log only. */
export function buildUnresolvedNote(issues:readonly ClaimIssue[],locale:Locale):string|null{
  if(!issues.length)return null;
  const labels=investigationLabels(locale);
  return labels.notConfirmed.replace("{count}",String(issues.length));
}
export function investigationReply(answer:InvestigationAnswer,observations:readonly Observation[],locale:Locale,
  options?:{ownerText?:string}):GroundedSupervisorReply|null{
  const rendered=renderInvestigationAnswer(answer,observations,locale,options);
  if(!rendered)return null;
  const labels=investigationLabels(locale);
  // Codex finding #4: built from the citations that actually survived
  // rendering, never from `answer.paragraphs` directly -- a dropped
  // paragraph's citations must never contribute a task card or a caution.
  const cited=observations.filter(o=>rendered.citedIds.includes(o.id));
  const pure=(cited.length>0&&cited.every(o=>o.calculation&&!o.reference))||rendered.hasComputedClaim;
  // Codex finding: a surviving evidence-kind paragraph that only NARRATES an
  // unavailable lookup (no token pulling a value out of it -- always fine,
  // per §2) earns no EvidenceReference at all (there is nothing real to
  // cite), so `rendered.evidence` stays empty even though `adviceOnly` is
  // false. The original check only ever produced "insufficient_evidence"
  // when `adviceOnly` was true, so this case fell through to "partial" with
  // zero evidence -- a shape validateGroundedReply's final gate correctly
  // has no allowlist for (unlike the pure-advice/pure-P3-conditional shapes
  // below, which are allowlisted there specifically because THEY always
  // have zero evidence by construction) and so rejected outright, replacing
  // an honest "I couldn't retrieve this" explanation with the generic
  // fallback. "insufficient_evidence" is simply the accurate status
  // whenever nothing real backs the reply, regardless of paragraph kind.
  const status=rendered.adviceOnly&&!answer.paragraphs.some(p=>p.kind==="advice")?"insufficient_evidence":
    !rendered.adviceOnly&&rendered.evidence.length===0?"insufficient_evidence":"partial";
  const warnings:SupervisorReplyBlock[]=[
    ...(pure?[{type:"warning" as const,code:"P3_CONDITIONAL",text:labels.conditional}]:
      rendered.adviceOnly?(answer.paragraphs.some(p=>p.kind==="advice")?[{type:"warning" as const,code:"SUPERVISOR_ADVICE",text:labels.advice}]:[]):
        [{type:"warning" as const,code:"SUPERVISOR_EVIDENCE_LIMITS",text:labels.partial}]),
    ...citationCautionWarnings(cited,locale),
  ];
  const cards=cited.flatMap(o=>o.reference?presentInvestigatedTasks(o.sourceContract,o.result.value,o.reference,locale):[])
    .filter((card,i,all)=>card.type!=="task_card"||all.findIndex(c=>c.type==="task_card"&&c.taskId===card.taskId)===i).slice(0,3);
  const unresolved=buildUnresolvedNote(rendered.issues,locale);
  return {intent:pure?"profitability":"unknown",status,evidence:rendered.evidence,
    blocks:[...warnings,...rendered.blocks,...cards,
      ...(unresolved?[{type:"warning" as const,code:"SUPERVISOR_PARTIAL_UNCONFIRMED",text:unresolved}]:[])]};
}
