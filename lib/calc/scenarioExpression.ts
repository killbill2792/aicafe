import { z } from "zod";
import { ownerQuotedUnitMatches } from "./scenarioUnitAttribution";
import { payrollTaxCents,staffCostLoadedCents } from "./staff";
import { roundHalfUpToCent } from "./money";

/** P3 read-only, deterministic arithmetic. The model never supplies café evidence. */
export const EXPRESSION_ID="platform.scenario.expression.v1" as const;
const bounded=z.number().int().safe().min(-1_000_000_000_000).max(1_000_000_000_000);
const id=z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.:-]+$/);
export const unit=z.enum(["USD_cents","USD_cents_per_item","USD_cents_per_hour",
  "USD_cents_per_US_gallon","USD_cents_per_US_fl_oz","item","minute","hour",
  "US_gallon","US_fl_oz","scalar","ratio_bps","comparison"]);
type Unit=z.infer<typeof unit>;
const period=z.strictObject({from:z.string().date(),to:z.string().date(),
  timezone:z.string().min(1).max(100)});
export const operandSchema=z.strictObject({
  handle:id,capabilityId:id,canonicalReaderId:id,sourceId:id,sourcePurpose:id,
  sourceRevision:id.nullable(),
  observedContentHash:z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable().optional(),
  selectorContractId:id,selectorContractVersion:z.literal(1),
  businessId:id,locationId:id.nullable(),asOf:z.string().date(),
  period:period.nullable(),status:z.enum(["verified","partial","estimated"]),
  actuality:z.enum(["actual","planned","estimated","forecast"]),
  evidenceStatus:z.enum(["verified","reported","unverified"]),
  missingInputs:z.array(id).max(20),staleInputs:z.array(id).max(20),
  unit,currency:z.literal("USD").nullable(),value:bounded,
});
export type Operand=z.infer<typeof operandSchema>;
export const bindingSchema=z.strictObject({
  capabilityId:id,canonicalReaderId:id,sourceIds:z.array(id).min(1).max(30),
  purposes:z.array(id).min(1).max(30),sensitivity:z.enum(["normal","staff","financial"]),
});
export type Binding=z.infer<typeof bindingSchema>;
const binary=z.strictObject({op:z.enum(["add","subtract","multiply","divide",
  "ratio","scenario_delta","compare","loaded_labor"])});
export const planSchema=z.strictObject({
  capabilityId:z.literal(EXPRESSION_ID),version:z.literal(1),
  purpose:z.enum(["preauthorized_operands","no_external_sources"]),
  description:z.string().min(2).max(300),
  nodes:z.array(z.union([
    z.strictObject({op:z.literal("source"),handle:id}),
    z.strictObject({op:z.literal("hypothetical"),label:z.string().min(2).max(160),
      quotedNumber:z.string().min(1).max(30),value:bounded,unit,
      // Zero-based occurrence among whole matches of this quoted number in the
      // owner message. Required when identical numbers have different units.
      occurrence:z.number().int().min(0).max(30).optional(),
      // Scaled integer quantity preserves exact fractional hours/volumes.
      quantityScale:z.enum(["whole","hundredth"]).optional(),
      // Quoted money may explicitly be cents, not just dollars.
      quotedDenomination:z.enum(["dollars","cents"]).optional()}),
    z.strictObject({op:z.literal("convert"),to:unit}),binary,
  ])).min(1).max(30),
});
export type Plan=z.infer<typeof planSchema>;
export type TrustedContext={
  businessId:string;locationId:string|null;ownerMessage:string;
  currency:"USD";bindings:readonly Binding[];operands:readonly Operand[];
};
export type ExpressionOutcome={
  status:"conditional"|"partial"|"unavailable";capabilityId:typeof EXPRESSION_ID;
  version:1;mode:"simulate";proposal:null;value:number|null;unit:Unit|null;
  currency:"USD"|null;formula:string[];assumptions:string[];
  sourceHandles:string[];missingInputs:string[];reason:string|null;executedEffects:0;
};
const unavailable=(reason:string):ExpressionOutcome=>({
  status:"unavailable",capabilityId:EXPRESSION_ID,version:1,mode:"simulate",
  proposal:null,value:null,unit:null,currency:null,formula:[],assumptions:[],
  sourceHandles:[],missingInputs:[],reason,executedEffects:0,
});
type Rat={n:bigint;d:bigint};
type Item={v:Rat;u:Unit;p:Operand["period"];refs:Set<string>};
const abs=(v:bigint)=>v<BigInt("0")?-v:v;
function rat(n:bigint,d:bigint=BigInt("1")):Rat{
  if(d===BigInt("0"))throw new Error("division_by_zero");
  if(d<BigInt("0")){n=-n;d=-d;}
  let a=abs(n),b=d;
  while(b!==BigInt("0")){const x=a%b;a=b;b=x;}
  return {n:n/a,d:d/a};
}
const plus=(a:Rat,b:Rat)=>rat(a.n*b.d+b.n*a.d,a.d*b.d);
const minus=(a:Rat,b:Rat)=>rat(a.n*b.d-b.n*a.d,a.d*b.d);
const times=(a:Rat,b:Rat)=>rat(a.n*b.n,a.d*b.d);
const divided=(a:Rat,b:Rat)=>rat(a.n*b.d,a.d*b.n);
const equalPeriod=(a:Item,b:Item)=>JSON.stringify(a.p)===JSON.stringify(b.p);
const mergeRefs=(a:Item,b:Item)=>new Set([...a.refs,...b.refs]);
/** Two independent café sources must share an explicit comparable period;
 * only an owner-stated hypothetical may inherit a sourced date window. */
const sourcePeriodsClash=(a:Item,b:Item):boolean=>Boolean(
  a.p&&b.p?!equalPeriod(a,b):
    (a.p&&b.refs.size>0)||(!a.p&&b.p&&a.refs.size>0));
function binaryOp(a:Item,b:Item,op:string,authorizedSources:ReadonlyMap<string,Operand>):Item{
  if(op==="loaded_labor"){
    // Canonical labor engine is authoritative; a declared employer burden
    // percentage is indispensable. No model-invented tax or overtime rule.
    // Wage-only inputs may be burdened. Never tax an already-loaded staff
    // cost, menu revenue or another domain's money a second time.
    const wageOnly=(handle:string)=>{
      const source=authorizedSources.get(handle);
      return source?.sourceId==="labor.employee_wages"&&
          source.handle.endsWith(":defaultHourlyWageCents")||
        source?.sourceId==="labor.daily_costs"&&
          source.handle.startsWith("labor.daily_costs:aggregate:wagesCents:");
    };
    if(a.u!=="USD_cents"||b.u!=="ratio_bps"||
      sourcePeriodsClash(a,b)||
      [...a.refs].some(handle=>!wageOnly(handle))||
      [...b.refs].some(handle=>authorizedSources.get(handle)?.sourceId!==
        "labor.payroll_burden"))
      throw new Error("invalid_loaded_labor_dimensions");
    if(b.v.n<BigInt(0)||b.v.n>b.v.d*BigInt(10_000))
      throw new Error("invalid_employer_burden");
    const wages=Number(a.v.n)/Number(a.v.d);
    const burden=Number(b.v.n)/Number(b.v.d)/10_000;
    if(!Number.isFinite(wages)||Math.abs(wages)>1_000_000_000_000||
      !Number.isFinite(burden))
      throw new Error("numeric_overflow");
    const loaded=roundHalfUpToCent(
      staffCostLoadedCents(wages,payrollTaxCents(wages,burden)));
    if(!Number.isSafeInteger(loaded)||
      Math.abs(loaded)>1_000_000_000_000)
      throw new Error("numeric_overflow");
    return {v:rat(BigInt(loaded)),u:"USD_cents",p:a.p??b.p,
      refs:mergeRefs(a,b)};
  }
  if(["add","subtract","scenario_delta","ratio","compare"].includes(op)){
    // Owner-quoted hypotheticals have no source period and can modify or
    // compare with an observed period. They inherit that observation's period.
    // TWO sourced quantities may never hide a missing/mismatched period.
    const periodsClash=sourcePeriodsClash(a,b);
    if(a.u!==b.u||periodsClash)
      throw new Error("incompatible_units_or_period");
    if(op==="ratio"||op==="compare"){
      if(op==="ratio"&&b.v.n===BigInt("0"))throw new Error("division_by_zero");
      const difference=a.v.n*b.v.d-b.v.n*a.v.d;
      return {v:op==="ratio"?times(divided(a.v,b.v),rat(BigInt("10000"))):
        rat(difference===BigInt("0")?BigInt("0"):difference>BigInt("0")?BigInt("1"):-BigInt("1")),
      u:op==="ratio"?"ratio_bps":"comparison",p:a.p??b.p,refs:mergeRefs(a,b)};
    }
    return {v:op==="add"?plus(a.v,b.v):minus(a.v,b.v),u:a.u,p:a.p??b.p,
      refs:mergeRefs(a,b)};
  }
  if(sourcePeriodsClash(a,b))throw new Error("incompatible_period");
  if(op==="multiply"){
    const lookup:Record<string,[Unit,bigint,bigint]>={
      "USD_cents_per_item*item":["USD_cents",BigInt("1"),BigInt("1")],
      "item*USD_cents_per_item":["USD_cents",BigInt("1"),BigInt("1")],
      "USD_cents_per_hour*hour":["USD_cents",BigInt("1"),BigInt("1")],
      "hour*USD_cents_per_hour":["USD_cents",BigInt("1"),BigInt("1")],
      "USD_cents_per_hour*minute":["USD_cents",BigInt("1"),BigInt("60")],
      "minute*USD_cents_per_hour":["USD_cents",BigInt("1"),BigInt("60")],
      "USD_cents_per_US_gallon*US_fl_oz":["USD_cents",BigInt("1"),BigInt("128")],
      "US_fl_oz*USD_cents_per_US_gallon":["USD_cents",BigInt("1"),BigInt("128")],
      "USD_cents_per_US_fl_oz*US_fl_oz":["USD_cents",BigInt("1"),BigInt("1")],
      "US_fl_oz*USD_cents_per_US_fl_oz":["USD_cents",BigInt("1"),BigInt("1")],
      "USD_cents*ratio_bps":["USD_cents",BigInt("1"),BigInt("10000")],
      "ratio_bps*USD_cents":["USD_cents",BigInt("1"),BigInt("10000")],
    };
    const key=a.u+"*"+b.u;
    const rule=lookup[key]??(
      // Basis points are dimensionless for all non-comparison dimensions;
      // preserve the unit and denominator, not just monetary rates.
      a.u!=="comparison"&&a.u!=="ratio_bps"&&b.u==="ratio_bps"?
        [a.u,BigInt("1"),BigInt("10000")] as [Unit,bigint,bigint]:
      b.u!=="comparison"&&b.u!=="ratio_bps"&&a.u==="ratio_bps"?
        [b.u,BigInt("1"),BigInt("10000")] as [Unit,bigint,bigint]:
      a.u==="scalar"?[b.u,BigInt("1"),BigInt("1")] as [Unit,bigint,bigint]:
      b.u==="scalar"?[a.u,BigInt("1"),BigInt("1")] as [Unit,bigint,bigint]:null);
    if(!rule)throw new Error("unsupported_dimensions");
    return {v:times(times(a.v,b.v),rat(rule[1],rule[2])),
      u:rule[0],p:a.p??b.p,refs:mergeRefs(a,b)};
  }
  if(op==="divide"){
    if(b.v.n===BigInt("0"))throw new Error("division_by_zero");
    let result:Unit|null=null;
    if(a.u===b.u)result="scalar";
    else if(b.u==="scalar")result=a.u;
    else if(a.u==="USD_cents"&&b.u==="item")result="USD_cents_per_item";
    else if(a.u==="USD_cents"&&b.u==="hour")result="USD_cents_per_hour";
    else if(a.u==="USD_cents"&&b.u==="US_gallon")result="USD_cents_per_US_gallon";
    else if(a.u==="USD_cents"&&b.u==="US_fl_oz")result="USD_cents_per_US_fl_oz";
    if(!result)throw new Error("unsupported_dimensions");
    return {v:divided(a.v,b.v),u:result,p:a.p??b.p,refs:mergeRefs(a,b)};
  }
  throw new Error("unsupported_operation");
}
function convert(a:Item,to:Unit):Item {
  if(a.u===to)return a;
  const rules:Record<string,[bigint,bigint]>={
    "minute:hour":[BigInt("1"),BigInt("60")],"hour:minute":[BigInt("60"),BigInt("1")],
    "US_gallon:US_fl_oz":[BigInt("128"),BigInt("1")],"US_fl_oz:US_gallon":[BigInt("1"),BigInt("128")],
    "USD_cents_per_US_gallon:USD_cents_per_US_fl_oz":[BigInt("1"),BigInt("128")],
    "USD_cents_per_US_fl_oz:USD_cents_per_US_gallon":[BigInt("128"),BigInt("1")],
  };
  const rule=rules[a.u+":"+to];
  if(!rule)throw new Error("unsupported_conversion");
  return {...a,v:times(a.v,rat(rule[0],rule[1])),u:to};
}
/** Localized numeric quoting is validated against the owner's exact input,
 * then canonicalized for arithmetic; grouping ambiguity fails closed. */
export function normalizeScenarioNumber(s:string):string {
  return s.replace(/[\u0660-\u0669\u06F0-\u06F9]/gu,c=>{
    const code=c.codePointAt(0)!;
    return String(code>=0x6f0?code-0x6f0:code-0x660);
  }).replace(/(?<=\d)[,\u066B\u066C](?=\d)/gu,".");
}
function attributed(message:string,quoted:string):boolean{
  const normalized=normalizeScenarioNumber(quoted);
  if(!/^-?\d+(?:\.\d{1,2})?$/.test(normalized))return false;
  // Consume the WHOLE numeric token, including repeated separators; never
  // attribute a fragment of a grouped or malformed quantity.
  const values:string[]=normalizeScenarioNumber(message).match(/-?\d+(?:\.\d+)*/g)??[];
  return values.includes(normalized);
}
/** A cent-denominated interpretation requires the owner's own nearby word
 * or symbol; the model is never allowed to reinterpret stated dollars as cents.
 */
function ownerQuotedCents(message:string,quoted:string,occurrence?:number):boolean{
  const raw=normalizeScenarioNumber(message).toLocaleLowerCase();
  const number=normalizeScenarioNumber(quoted);
  const token=/[\p{L}\p{N}]/u;
  let validOccurrence=0;
  for(let start=raw.indexOf(number);start>=0;start=raw.indexOf(number,start+1)){
    const prev=raw[start-1]??"",next=raw[start+number.length]??"";
    if((prev&&token.test(prev))||(next&&token.test(next)))continue;
    if(occurrence!==undefined && validOccurrence++!==occurrence)continue;
    const after=raw.slice(start+number.length,start+number.length+24);
    const before=raw.slice(Math.max(0,start-6),start);
    if(/^\s*(?:¢|cents?\b|centavos?\b|سنت(?:ات)?|سنتيم(?:ات)?)/u.test(after)||
      /¢\s*$/u.test(before))return true;
  }
  return false;
}
/** Avoid IEEE-754 multiplication when converting owner decimals to cents
 * or hundredth units; the integer interpretation is computed from digits.
 */
function scaledOwnerNumber(quoted:string,factor:number):bigint|null{
  const match=/^(-?)([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(
    normalizeScenarioNumber(quoted));
  if(!match)return null;
  const whole=BigInt(match[2]),part=BigInt((match[3]??"").padEnd(2,"0")||"0");
  const numerator=(whole*BigInt("100")+part)*BigInt(factor);
  if(numerator%BigInt("100")!==BigInt("0"))return null;
  const signed=numerator/BigInt("100");
  return match[1]? -signed:signed;
}
function rounded(v:Rat):number{
  const amount=(abs(v.n)*BigInt("2")+v.d)/(v.d*BigInt("2"));
  const signed=v.n<BigInt("0")?-amount:amount;
  if(abs(signed)>BigInt(Number.MAX_SAFE_INTEGER))throw new Error("integer_overflow");
  return Number(signed);
}
function resultValue(item:Item):number{
  if(["item","minute","hour","US_gallon","US_fl_oz","scalar"].includes(item.u)){
    const value=Number(item.v.n)/Number(item.v.d);
    if(!Number.isFinite(value)||Math.abs(value)>1_000_000_000_000)
      throw new Error("numeric_overflow");
    return value;
  }
  // Monetary results remain integer cents; no intermediate rounding.
  return rounded(item.v);
}
/** All supplied source operands must come from already authorized P1 reads. */
export function evaluateExpression(raw:unknown,context:TrustedContext):ExpressionOutcome {
  const p=planSchema.safeParse(raw);
  if(!p.success)return unavailable("invalid_plan");
  const plan=p.data;
  if(!context.businessId||context.currency!=="USD"||
    context.operands.length>12||context.bindings.length>100)
    return unavailable("scope_or_budget");
  const includesSource=plan.nodes.some(n=>n.op==="source");
  if(plan.purpose==="no_external_sources"&&(includesSource||context.operands.length)||
    plan.purpose==="preauthorized_operands"&&!includesSource)
    return unavailable("source_contract_mismatch");
  const registry=new Map(context.bindings.map(b=>[b.capabilityId,b]));
  const refs=new Map<string,Operand>();
  for(const rawOperand of context.operands){
    const parsed=operandSchema.safeParse(rawOperand);
    if(!parsed.success)return unavailable("invalid_source");
    const o=parsed.data,b=registry.get(o.capabilityId);
    if(refs.has(o.handle)||o.businessId!==context.businessId||
      context.locationId!==null&&o.locationId!==context.locationId||
      !b||b.canonicalReaderId!==o.canonicalReaderId||
      !b.sourceIds.includes(o.sourceId)||!b.purposes.includes(o.sourcePurpose)||
      o.status==="verified"&&(!o.sourceRevision||o.actuality!=="actual"||
        o.evidenceStatus!=="verified"||o.missingInputs.length>0||o.staleInputs.length>0)||
      o.unit.startsWith("USD_")&&o.currency!=="USD")
      return unavailable("invalid_source");
    refs.set(o.handle,o);
  }
  // A successful operand binding is not enough: an expression MUST NOT
  // combine different database commit states (or revised and unversioned
  // observations) into one apparently coherent financial calculation.
  const revisions=new Set([...refs.values()].map(o=>o.sourceRevision));
  if(revisions.size>1)return unavailable("mixed_source_revisions");
  const stack:Item[]=[],formula:string[]=[],assumptions:string[]=[],missing=new Set<string>();
  try{
    for(const node of plan.nodes){
      if(node.op==="source"){
        const v=refs.get(node.handle);
        if(!v)throw new Error("unregistered_operand");
        if(v.status!=="verified"||v.evidenceStatus!=="verified"||
          v.actuality!=="actual")missing.add("unverified:"+v.handle);
        if(!v.sourceRevision)missing.add("unversioned_source:"+v.handle);
        for(const s of [...v.missingInputs,...v.staleInputs])missing.add(s);
        stack.push({v:rat(BigInt(v.value)),u:v.unit,p:v.period,refs:new Set([v.handle])});
        formula.push("source("+v.handle+")");
      }else if(node.op==="hypothetical"){
        if(!attributed(context.ownerMessage,node.quotedNumber))
          throw new Error("invented_hypothetical");
        if(!ownerQuotedUnitMatches(context.ownerMessage,node.quotedNumber,node.unit,node.occurrence))
          throw new Error("hypothetical_unit_mismatch");
        const isMoney=node.unit.startsWith("USD_");
        const ownerSaidCents=ownerQuotedCents(context.ownerMessage,node.quotedNumber,node.occurrence);
        if((!isMoney&&node.quotedDenomination!==undefined)||
          (isMoney&&node.quantityScale==="hundredth")||
          (isMoney && (node.quotedDenomination==="cents")!==ownerSaidCents))
          throw new Error("denomination_mismatch");
        const quantityScale=node.quantityScale==="hundredth"?100:1;
        const factor=isMoney?(node.quotedDenomination==="cents"?1:100):
          node.unit==="ratio_bps"?100:quantityScale;
        const interpreted=scaledOwnerNumber(node.quotedNumber,factor);
        if(interpreted===null||interpreted!==BigInt(node.value))
          throw new Error("hypothetical_mismatch");
        stack.push({v:rat(BigInt(node.value),BigInt(
          isMoney||node.unit==="ratio_bps"?1:quantityScale)),
          u:node.unit,p:null,refs:new Set()});
        // Never publish the model's free-form label as an owner-verified fact.
        assumptions.push(node.quotedNumber+" "+
          (node.quotedDenomination==="cents"?"cents":node.unit));
        formula.push("owner_hypothetical");
      }else if(node.op==="convert"){
        const a=stack.pop();if(!a)throw new Error("stack_underflow");
        stack.push(convert(a,node.to));formula.push("convert("+node.to+")");
      }else{
        const rhs=stack.pop(),lhs=stack.pop();
        if(!lhs||!rhs)throw new Error("stack_underflow");
        stack.push(binaryOp(lhs,rhs,node.op,refs));formula.push(node.op);
      }
      if(stack.length>12)throw new Error("stack_budget");
      const top=stack.at(-1);
      if(top && abs(top.v.n)>BigInt("1000000000000000")*top.v.d)
        throw new Error("numeric_overflow");
    }
    if(stack.length!==1)throw new Error("invalid_stack");
    const answer=stack[0];
    return {status:missing.size?"partial":"conditional",
      capabilityId:EXPRESSION_ID,version:1,mode:"simulate",proposal:null,
      value:resultValue(answer),unit:answer.u,
      currency:answer.u.startsWith("USD_")?"USD":null,
      formula,assumptions,sourceHandles:[...answer.refs],missingInputs:[...missing],
      reason:missing.size?"incomplete_evidence":null,executedEffects:0};
  }catch(e){return unavailable(e instanceof Error?e.message:"calculation_failed");}
}
