import {z} from "zod";
import {randomUUID} from "node:crypto";
import type {AgentToolContext,AgentToolResult} from "./index";
import {CALC_OPS,exactDecimal,exactNumber,runCalculation,type CalcOp,type CalcShown,type CalcUnit,type CalcValue} from "@/lib/metrics/core/calculator";
import type {ExplainLine} from "../explain";
import type {CardValue} from "@/lib/format/values";
import {ownerStatedAmounts} from "../checkNumbers";
import {completeResearchAttempts} from "../researchRecovery";

const name=z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u);
const calculateInput=z.strictObject({
  purpose:z.string().trim().min(1).max(120),
  inputs:z.array(z.strictObject({
    name,label:z.string().trim().min(1).max(50),
    tool:z.string().max(64).nullable(),
    path:z.string().max(200).nullable(),
    receipt_id:z.uuid().nullable(),
    fact_key:z.string().max(120).nullable(),
    owner_value:z.number().finite().nullable(),
    owner_unit:z.enum(["cents","percent","count"]).nullable(),
    // Explicitly hypothetical, never represented as an observed business input.
    assumption:z.strictObject({value:z.number().finite(),unit:z.enum(["cents","percent","count","ratio"]),basis:z.string().trim().min(1).max(500)}).nullable().optional(),
  })).min(1),
  steps:z.array(z.strictObject({
    id:name,label:z.string().trim().min(1).max(50),
    op:z.enum(CALC_OPS as [CalcOp,...CalcOp[]]),
    args:z.array(name).min(1),
  })).min(1),
});

type TurnResult={name:string;result:AgentToolResult};
type SavedFact={fact_key:string;value_json:unknown;unit:string|null};
type CalcContext=AgentToolContext&{turnResults?:()=>readonly TurnResult[];savedOwnerFacts?:readonly SavedFact[]};
type Input={name:string;label:string;value:CalcValue;from:"tool"|"owner_fact"|"owner_said"|"assumption";ref:string;estimate:boolean;owner:boolean;partial:boolean;
  period:{from:string;to:string}|null};

// Exact intermediate values stay in the actual result object's lifetime.
// The model gets a receipt and displayed numbers, never authority to supply
// the underlying rational or reuse a receipt from another turn/café.
const exactCalculations=new WeakMap<AgentToolResult,{values:Map<string,CalcValue>;estimate:boolean;partial:boolean;owner:boolean}>();

// Private server-side continuation only. The exact rational never appears in
// the tool result or a model argument, nor can a model install a receipt.
const exactSnapshotSchema=z.strictObject({
 values:z.array(z.tuple([z.string().regex(/^(?:result|steps\.\d+)$/),z.strictObject({
  n:z.string().regex(/^-?\d{1,1235}$/),d:z.string().regex(/^[1-9]\d{0,1234}$/),
  unit:z.enum(["cents","count","percent","ratio"])
 })])),
 estimate:z.boolean(),partial:z.boolean(),owner:z.boolean()
});
export function snapshotExactCalculation(result:AgentToolResult){
 const exact=exactCalculations.get(result);
 if(!exact)return null;
 return {...exact,values:[...exact.values].map(([path,v])=>[path,{n:v.n.toString(),d:v.d.toString(),unit:v.unit}] as const)};
}
export function restoreExactCalculation(result:AgentToolResult,raw:unknown){
 if(raw===null)return;
 if(result.source!=="calculate"||result.refused||result.error)throw Error("research_checkpoint_invalid");
 const saved=exactSnapshotSchema.parse(raw);
 const values=new Map<string,CalcValue>();
 for(const [path,v] of saved.values){
  if(values.has(path))throw Error("research_checkpoint_invalid");
  const n=BigInt(v.n),d=BigInt(v.d);
  if(n.toString(2).replace("-","").length>4096||d.toString(2).length>4096)
   throw Error("research_checkpoint_invalid");
  values.set(path,{n,d,unit:v.unit});
 }
 if(!values.has("result"))throw Error("research_checkpoint_invalid");
 exactCalculations.set(result,{...saved,values});
}

/** Unit from the field name the value was read from. Never guessed from the number. */
function unitForField(field:string,value:number):CalcValue|null{
  if(/cents$/iu.test(field))return Number.isInteger(value)?exactNumber(value,"cents"):null;
  if(/^(?:costPerBaseUnitMicros|cost_per_base_unit_micros)$/u.test(field))return exactNumber(value,"cents",1000000);
  if(/bps$/iu.test(field))return exactNumber(value,"percent",10000);
  if(/percent$/iu.test(field))return exactNumber(value,"percent",100);
  if(/(?:rate|ratio|margin|share)$/iu.test(field))return exactNumber(value,"percent");
  return exactNumber(value,"count");
}
/** Only the SQL parser/authorized catalog may attest an exact research
 * result unit. Model-selected result aliases are untrusted labels. */
function exactResearchField(verifiedUnit:unknown,value:string|number):CalcValue|null{
 const amount=typeof value==="string"?value:
   Number.isFinite(value)?String(value):"";
 if(verifiedUnit==="microcents")return exactDecimal(amount,"cents",1000000);
 const unit:CalcUnit|null=
  verifiedUnit==="cents"||verifiedUnit==="count"||
  verifiedUnit==="percent"||verifiedUnit==="ratio"?verifiedUnit:null;
 if(!unit)return null;
 const scale=unit==="percent"?100:1;
 // A verified SQL average may contain fractional cents. Keep the exact
 // rational until the display boundary, rather than rejecting the aggregate.
 return exactDecimal(amount,unit,scale);
}
function readPath(root:unknown,path:string):unknown{
  let node=root;
  for(const part of path.split(".")){
    if(node===null||typeof node!=="object")return undefined;
    if(Array.isArray(node)){
      if(!/^\d+$/u.test(part))return undefined;
      node=node[Number(part)];
    }else{
      if(!Object.hasOwn(node,part))return undefined;
      node=(node as Record<string,unknown>)[part];
    }
  }
  return node;
}
const isEstimate=(r:AgentToolResult)=>r.status==="estimate"||r.provenance==="estimate"||r.kind==="estimate"||
  (Array.isArray(r.estimated)&&r.estimated.length>0)||(typeof r.estimated==="boolean"&&r.estimated);
/** Refusals are for the model to fix, never owner questions: no error/missing keys. */
const refuse=(code:string,detail?:string):AgentToolResult=>
  ({source:"calculate",period:null,agentId:"leo",missing:[],refused:code,...(detail?{detail}:{})});

const symbol:Record<CalcOp,string>={add:" + ",subtract:" − ",multiply:" × ",divide:" ÷ ",sum:" + ",percent_of:" × "};
const formulaFor:Record<CalcOp,ExplainLine["formula"]>={add:"sum",sum:"sum",subtract:"subtract",
  multiply:"multiply",percent_of:"multiply",divide:"divide"};
function card(s:CalcShown|undefined):CardValue|null{
  if(!s)return null;
  if(s.unit==="cents")return {kind:"money",cents:s.valueCents};
  if(s.unit==="percent")return {kind:"percent",bps:s.valueBps};
  if(s.unit==="count"&&Number.isInteger(s.quantity))return {kind:"count",n:s.quantity};
  return null;
}
/** Union per message, so numbers from two messages never merge into one. */
function ownerSaid(ctx:CalcContext,locale:AgentToolContext["locale"]){
  const all={money:new Set<number>(),percent:new Set<number>(),number:new Set<number>()};
  for(const text of [...(ctx.ownerMessages??[]),...(ctx.ownerText?[ctx.ownerText]:[])]){
    const found=ownerStatedAmounts(text,locale,true);
    for(const k of ["money","percent","number"] as const)for(const v of found[k])all[k].add(v);
  }
  return all;
}
const unitName:Record<CalcUnit,string>={cents:"cents",percent:"percent",count:"count",ratio:"ratio"};

export const calculateTools={
  calculate:{
    agentId:"leo" as const,schema:calculateInput,
    description:"Perform exact traceable arithmetic (+ − × ÷, sum, percent_of) over verified authorized inputs. SQL may already have performed the needed arithmetic; do not repeat it unnecessarily. "+
      "Independently chosen assumptions and alternative definitions are not official screen values; label their basis accurately. "+
      "Each input reads ONE number: either tool + path (dot path into the exact tool result, e.g. rows.0.net_sales_cents), "+
      "For SQL rows use the exact evidence.receipt_id and typed numeric column, e.g. rows.0.amount. For an earlier calculator result use tool calculate, its exact evidence.receipt_id and path result or steps.<zero-based index>; this preserves the unrounded value. Otherwise set receipt_id to null. "+
      "or fact_key (a saved owner fact, including a question-card answer), "+
      "or owner_value + owner_unit for a number the owner said in chat (cents for money, 20 for 20%, plain count). "+
      "For hypothetical scenarios only, provide assumption {value,unit,basis}; disclose that it is hypothetical, not observed or owner-provided. Set unused fields to null. Never invent a recorded value. Say You told me for owner numbers. "+
      "Steps run in order; args name inputs or earlier step ids; percent_of takes (percent, value). "+
      "Show the inputs, formula and steps in How I got this, and label the result Calculation or Estimate as returned.",
    async execute(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>{
      const untrusted=raw&&typeof raw==="object"&&!Array.isArray(raw)?
        raw as Record<string,unknown>:{};
      const provided=Array.isArray(untrusted.inputs)?untrusted.inputs.map(item=>
        item&&typeof item==="object"&&!Array.isArray(item)?
        {receipt_id:null,assumption:null,...item}:item):untrusted.inputs;
      // Historical recorded calls may contain the retired topic label; ignore it.
      const {screen_number:_retiredTopic,...general}=untrusted;
      void _retiredTopic;
      const p=calculateInput.parse({...general,inputs:provided});
      const scoped=ctx as CalcContext;
      const turn=completeResearchAttempts((scoped.turnResults?.()??[]).filter(r=>r.name!=="ask_owner"));
      const facts=scoped.savedOwnerFacts??[];
      const inputs:Input[]=[];
      const inputNames=new Set<string>();
      for(const input of p.inputs){
        if(inputNames.has(input.name))return refuse("duplicateName",input.name);
        inputNames.add(input.name);
        const owner=input.owner_value!==null||input.owner_unit!==null;
        if(input.assumption){
          if(input.tool||input.path||input.fact_key||owner||input.receipt_id)return refuse("ambiguousInput",input.name);
          const {value,unit,basis}=input.assumption;
          const exact=unit==="cents"&&!Number.isInteger(value)?null:exactNumber(value,unit,unit==="percent"?100:1);
          if(!exact)return refuse("invalidNumber",input.name);
          inputs.push({name:input.name,label:input.label,value:exact,from:"assumption",ref:basis,
            estimate:true,owner:false,partial:false,period:null});
        }else if(input.tool&&input.path&&!input.fact_key&&!owner){
          const candidates=turn.filter(r=>r.name===input.tool);
          const receipt=(r:TurnResult)=>{
            const evidence=(r.result as Record<string,unknown>).evidence;
            return evidence&&typeof evidence==="object"&&!Array.isArray(evidence)?
              (evidence as Record<string,unknown>).receipt_id:null;
          };
          const hit=input.receipt_id?
            candidates.find(r=>receipt(r)===input.receipt_id):
            [...candidates].reverse()[0];
          if(!hit)return refuse(input.receipt_id?"receiptNotFound":"toolNotCalledThisTurn",
            input.receipt_id??input.tool);
          if(hit.result.source==="calculate"){
            if(!input.receipt_id)return refuse("calculationReceiptRequired",input.name);
            const prior=exactCalculations.get(hit.result);
            const exact=prior?.values.get(input.path);
            if(!prior||!exact)return refuse("calculationReceiptUnavailable",input.path);
            inputs.push({name:input.name,label:input.label,value:exact,from:"tool",
              ref:"calculate:"+input.receipt_id+":"+input.path,estimate:prior.estimate,
              owner:prior.owner,partial:prior.partial,period:hit.result.period});
            continue;
          }
          if(hit.result.error||hit.result.refused)return refuse("inputSourceFailed",input.name);
          const isResearch=hit.result.source==="u3_canonical_research";
          if(isResearch&&!input.receipt_id)return refuse("researchReceiptRequired",input.tool);
          if(isResearch&&!/^rows\.\d+\.[a-zA-Z_][a-zA-Z0-9_]{0,99}$/u.test(input.path))
            return refuse("researchRowPathRequired",input.path);
          if(isResearch&&(!hit.result.evidence||typeof hit.result.evidence!=="object"||
            (hit.result.evidence as Record<string,unknown>).scope!=="verified_owner_cafe_lease"))
            return refuse("researchReceiptUnverified",input.tool);
          const value=readPath(hit.result,input.path);
          if(value===null)return refuse("inputIsUnknown",input.name+" ("+input.path+" is null; never use it as zero)");
          if(typeof value!=="number"&&
            !(isResearch&&typeof value==="string"))
            return refuse("pathIsNotANumber",input.path);
          const field=input.path.split(".").at(-1)??"";
          const e=(hit.result as Record<string,unknown>).evidence;
          const proof=e&&typeof e==="object"&&!Array.isArray(e)?
            (e as Record<string,unknown>).column_units:null;
          const columnUnits=proof&&typeof proof==="object"&&!Array.isArray(proof)?
            proof as Record<string,unknown>:null;
          const attestedUnit=columnUnits&&Object.hasOwn(columnUnits,field)?
            columnUnits[field]:null;
          const exact=isResearch?
            exactResearchField(attestedUnit,value as string|number):
            unitForField(field,value as number);
          if(!exact)return refuse(isResearch?"researchUnitUnverified":"invalidNumber",input.path);
          inputs.push({name:input.name,label:input.label,value:exact,from:"tool",
            ref:input.tool+":"+(input.receipt_id?input.receipt_id+":":"")+input.path,
            estimate:isEstimate(hit.result),owner:false,
            partial:hit.result.missing.length>0||hit.result.truncated===true,period:hit.result.period});
        }else if(input.fact_key&&!input.tool&&!input.path&&!owner&&!input.receipt_id){
          const fact=facts.find(f=>f.fact_key===input.fact_key);
          if(!fact)return refuse("factNotSaved",input.fact_key);
          if(typeof fact.value_json!=="number")return refuse("factIsNotANumber",input.fact_key);
          const field=fact.unit==="cents"?"cents":fact.unit==="percent"?"percent":input.fact_key;
          const exact=unitForField(field,fact.value_json);
          if(!exact)return refuse("invalidNumber",input.fact_key);
          inputs.push({name:input.name,label:input.label,value:exact,from:"owner_fact",ref:input.fact_key,
            estimate:false,owner:true,partial:false,period:null});
        }else if(input.owner_value!==null&&input.owner_unit!==null&&!input.tool&&!input.path&&!input.fact_key&&!input.receipt_id){
          // The owner's own words this turn or in recent messages (incl. a typed card answer).
          const v=input.owner_value,unit=input.owner_unit;
          const said=ownerSaid(scoped,ctx.locale);
          const key=unit==="cents"?"money":unit==="percent"?"percent":"number";
          const want=unit==="percent"?Math.round(v*100):v;
          if(unit==="cents"&&!Number.isInteger(v))return refuse("centsMustBeWhole",input.name);
          if(!said[key].has(want))return refuse("ownerDidNotSayThis",input.name+" ("+v+" "+unit+")");
          const exact=unit==="cents"?exactNumber(v,"cents"):unit==="percent"?exactNumber(v,"percent",100):exactNumber(v,"count");
          if(!exact)return refuse("invalidNumber",input.name);
          inputs.push({name:input.name,label:input.label,value:exact,from:"owner_said",ref:"owner",
            estimate:false,owner:true,partial:false,period:null});
        }else return refuse("inputNeedsToolAndPathOrFactKey",input.name);
      }
      const run=runCalculation(new Map(inputs.map(i=>[i.name,i.value])),p.steps);
      if(!run.ok)return refuse(run.code,run.stepId);
      const labels=new Map<string,string>([...inputs.map(i=>[i.name,i.label] as const),...p.steps.map(s=>[s.id,s.label] as const)]);
      const expr=new Map<string,string>(inputs.map(i=>[i.name,i.name]));
      for(const s of p.steps){
        const parts=s.args.map(a=>expr.get(a)??a);
        // A formula DAG can expand exponentially if earlier steps are
        // duplicated. Use named step references once the display expression
        // would exceed the existing explanation display size.
        const expanded=parts.join(symbol[s.op]);
        const formula=expanded.length<=240?expanded:s.args.join(symbol[s.op]);
        expr.set(s.id,s===p.steps[p.steps.length-1]?formula:"("+formula+")");
      }
      const partial=inputs.some(i=>i.partial);
      const estimate=inputs.some(i=>i.estimate||i.owner)||partial;
      const provenance:ExplainLine["provenance"]=inputs.some(i=>i.estimate)||partial?"estimate":
        inputs.some(i=>i.owner)?"ownerProvided":"recorded";
      const periodInputs=inputs.map(i=>i.period).filter((p):p is {from:string;to:string}=>p!==null);
      const periods=[...new Set(periodInputs.map(p=>p.from+"/"+p.to))];
      const period=periods.length===1&&periodInputs.length===inputs.length?periodInputs[0]:null;
      const shownOf=new Map<string,CalcShown>();
      for(const i of inputs){const r=runCalculation(new Map([[i.name,i.value]]),[{id:"v",op:"sum",args:[i.name]}]);
        if(r.ok)shownOf.set(i.name,r.result.shown);}
      for(const s of run.steps)shownOf.set(s.id,s.shown);
      const explain:ExplainLine[]=[];
      for(const s of run.steps){
        const result=card(s.shown);
        const values=s.args.map(a=>({name:(labels.get(a)??a).slice(0,50),value:card(shownOf.get(a)!)}));
        if(!result||values.some(v=>!v.value))continue;
        explain.push({label:s===run.result?p.purpose:labels.get(s.id)!,
          inputs:values.map(v=>({name:v.name,value:v.value!})),formula:formulaFor[s.op],result,period,
          source:"calculate",provenance,
          basis:(expr.get(s.id)??"").slice(0,240)});
      }
      const resultShown=run.result.shown;
      const numberEstimates=resultShown.unit==="cents"?[{value:resultShown.valueCents,unit:"cents" as const}]:
        resultShown.unit==="percent"?[{value:resultShown.valueBps,unit:"bps" as const}]:
        resultShown.unit==="count"&&Number.isInteger(resultShown.quantity)?
          [{value:resultShown.quantity,unit:"count" as const}]:[];
      const result:AgentToolResult={source:"calculate",period,agentId:"leo",missing:partial?["incompleteCalculationInputs"]:[],numberEstimates,
        evidence:{receipt_id:randomUUID(),authority:"exact_arithmetic_from_verified_inputs"},
        ...(inputs.some(i=>i.from==="assumption")?{assumptions:inputs.filter(i=>i.from==="assumption").map(i=>({name:i.name,basis:i.ref}))}:{}),
        kind:estimate?"estimate":"calculation",purpose:p.purpose,formula:expr.get(run.result.id),
        inputs:inputs.map(i=>({name:i.name,label:i.label,from:i.from,ref:i.ref,unit:unitName[i.value.unit],...shownOf.get(i.name)})),
        steps:run.steps.map(s=>({id:s.id,label:labels.get(s.id),op:s.op,args:s.args,...s.shown})),
        result:{...run.result.shown},
        ...(inputs.some(i=>i.owner)?{ownerProvided:inputs.filter(i=>i.owner).map(i=>i.name)}:{}),
        ...(inputs.some(i=>i.partial)?{basedOnPartialData:inputs.filter(i=>i.partial).map(i=>i.ref.split(":")[0])}:{}),
        explain};
      exactCalculations.set(result,{values:new Map([["result",run.result.value],...run.steps.map((step,index)=>["steps."+index,step.value] as const)]),estimate,partial,owner:inputs.some(i=>i.owner)});
      return result;
    },
  },
};
