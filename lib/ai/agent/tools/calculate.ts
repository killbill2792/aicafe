import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
import {CALC_OPS,exactNumber,runCalculation,type CalcOp,type CalcShown,type CalcUnit,type CalcValue} from "@/lib/metrics/core/calculator";
import {SCREEN_NUMBERS,SCREEN_NUMBER_IDS,type ScreenNumber} from "../screenNumbers";
import type {ExplainLine} from "../explain";
import type {CardValue} from "@/lib/format/values";
import {ownerStatedAmounts} from "../checkNumbers";

const name=z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u);
const calculateInput=z.strictObject({
  purpose:z.string().trim().min(1).max(120),
  screen_number:z.enum(["none",...SCREEN_NUMBER_IDS] as [string,...string[]]),
  inputs:z.array(z.strictObject({
    name,label:z.string().trim().min(1).max(50),
    tool:z.string().max(64).nullable(),
    path:z.string().max(200).nullable(),
    fact_key:z.string().max(120).nullable(),
    owner_value:z.number().finite().nullable(),
    owner_unit:z.enum(["cents","percent","count"]).nullable(),
  })).min(1).max(12),
  steps:z.array(z.strictObject({
    id:name,label:z.string().trim().min(1).max(50),
    op:z.enum(CALC_OPS as [CalcOp,...CalcOp[]]),
    args:z.array(name).min(1).max(8),
  })).min(1).max(12),
});

type TurnResult={name:string;result:AgentToolResult};
type SavedFact={fact_key:string;value_json:unknown;unit:string|null};
type CalcContext=AgentToolContext&{turnResults?:()=>readonly TurnResult[];savedOwnerFacts?:readonly SavedFact[]};
type Input={name:string;label:string;value:CalcValue;from:"tool"|"owner_fact"|"owner_said";ref:string;estimate:boolean;owner:boolean;partial:boolean;
  period:{from:string;to:string}|null};

/** Unit from the field name the value was read from. Never guessed from the number. */
function unitForField(field:string,value:number):CalcValue|null{
  if(/cents$/iu.test(field))return Number.isInteger(value)?exactNumber(value,"cents"):null;
  if(/bps$/iu.test(field))return exactNumber(value,"percent",10000);
  if(/percent$/iu.test(field))return exactNumber(value,"percent",100);
  if(/(?:rate|ratio|margin|share)$/iu.test(field))return exactNumber(value,"percent");
  return exactNumber(value,"count");
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
const isEstimate=(r:AgentToolResult)=>r.status==="estimate"||r.provenance==="estimate"||
  (Array.isArray(r.estimated)&&r.estimated.length>0)||(typeof r.estimated==="boolean"&&r.estimated);
/** Refusals are for the model to fix, never owner questions: no error/missing keys. */
const refuse=(code:string,detail?:string):AgentToolResult=>
  ({source:"calculate",period:null,agentId:"leo",missing:[],refused:code,...(detail?{detail}:{})});

const symbol:Record<CalcOp,string>={add:" + ",subtract:" − ",multiply:" × ",divide:" ÷ ",sum:" + ",percent_of:" × "};
const formulaFor:Record<CalcOp,ExplainLine["formula"]>={add:"sum",sum:"sum",subtract:"subtract",
  multiply:"multiply",percent_of:"multiply",divide:"divide"};
function card(s:CalcShown):CardValue|null{
  if(s.unit==="cents")return {kind:"money",cents:s.valueCents};
  if(s.unit==="percent")return {kind:"percent",bps:s.valueBps};
  if(s.unit==="count"&&Number.isInteger(s.quantity))return {kind:"count",n:s.quantity};
  return null;
}
/** Union per message, so numbers from two messages never merge into one. */
function ownerSaid(ctx:CalcContext,locale:AgentToolContext["locale"]){
  const all={money:new Set<number>(),percent:new Set<number>(),number:new Set<number>()};
  for(const text of [...(ctx.ownerMessages??[]),...(ctx.ownerText?[ctx.ownerText]:[])]){
    const found=ownerStatedAmounts(text,locale);
    for(const k of ["money","percent","number"] as const)for(const v of found[k])all[k].add(v);
  }
  return all;
}
const unitName:Record<CalcUnit,string>={cents:"cents",percent:"percent",count:"count",ratio:"ratio"};

export const calculateTools={
  calculate:{
    agentId:"leo" as const,schema:calculateInput,
    description:"The only way to do arithmetic (+ − × ÷, sum, percent_of) for numbers that are NOT screen numbers. "+
      "Screen numbers (profit, labor cost, card fees, break-even, item cost) come only from their own tools; "+
      "set screen_number to the one this result is about, or none, and start from that tool's number. "+
      "Each input reads ONE number: either tool (a tool name called earlier this turn) + path (dot path into its result, e.g. rows.0.net_sales_cents), "+
      "or fact_key (a saved owner fact, including a question-card answer), "+
      "or owner_value + owner_unit for a number the owner said in chat (cents for money, 20 for 20%, plain count). "+
      "Set the unused fields to null. Never type any other number. Say You told me for owner numbers. "+
      "Steps run in order; args name inputs or earlier step ids; percent_of takes (percent, value). "+
      "Show the inputs, formula and steps in How I got this, and label the result Calculation or Estimate as returned.",
    async execute(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>{
      const p=calculateInput.parse(raw);
      const scoped=ctx as CalcContext;
      const turn=(scoped.turnResults?.()??[]).filter(r=>r.name!=="calculate"&&r.name!=="ask_owner");
      const facts=scoped.savedOwnerFacts??[];
      const inputs:Input[]=[];
      for(const input of p.inputs){
        if(inputs.some(i=>i.name===input.name))return refuse("duplicateName",input.name);
        const owner=input.owner_value!==null||input.owner_unit!==null;
        if(input.tool&&input.path&&!input.fact_key&&!owner){
          const hit=[...turn].reverse().find(r=>r.name===input.tool);
          if(!hit)return refuse("toolNotCalledThisTurn",input.tool);
          const value=readPath(hit.result,input.path);
          if(value===null)return refuse("inputIsUnknown",input.name+" ("+input.path+" is null; never use it as zero)");
          if(typeof value!=="number")return refuse("pathIsNotANumber",input.path);
          const field=input.path.split(".").at(-1)??"";
          const exact=unitForField(field,value);
          if(!exact)return refuse("invalidNumber",input.path);
          inputs.push({name:input.name,label:input.label,value:exact,from:"tool",ref:input.tool+":"+input.path,
            estimate:isEstimate(hit.result),owner:false,partial:hit.result.missing.length>0,period:hit.result.period});
        }else if(input.fact_key&&!input.tool&&!input.path&&!owner){
          const fact=facts.find(f=>f.fact_key===input.fact_key);
          if(!fact)return refuse("factNotSaved",input.fact_key);
          if(typeof fact.value_json!=="number")return refuse("factIsNotANumber",input.fact_key);
          const field=fact.unit==="cents"?"cents":fact.unit==="percent"?"percent":input.fact_key;
          const exact=unitForField(field,fact.value_json);
          if(!exact)return refuse("invalidNumber",input.fact_key);
          inputs.push({name:input.name,label:input.label,value:exact,from:"owner_fact",ref:input.fact_key,
            estimate:false,owner:true,partial:false,period:null});
        }else if(input.owner_value!==null&&input.owner_unit!==null&&!input.tool&&!input.path&&!input.fact_key){
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
      // Never rebuild a screen number: a result about one must start from its own tool.
      if(p.screen_number!=="none"){
        const allowed:readonly string[]=SCREEN_NUMBERS[p.screen_number as ScreenNumber];
        if(!inputs.some(i=>i.from==="tool"&&allowed.includes(i.ref.split(":")[0])))
          return refuse("screenNumberComesFromItsTool","call "+allowed.join(" or ")+" and use its number as an input");
      }
      const run=runCalculation(new Map(inputs.map(i=>[i.name,i.value])),p.steps);
      if(!run.ok)return refuse(run.code,run.stepId);
      const labels=new Map<string,string>([...inputs.map(i=>[i.name,i.label] as const),...p.steps.map(s=>[s.id,s.label] as const)]);
      const expr=new Map<string,string>(inputs.map(i=>[i.name,i.name]));
      for(const s of p.steps){
        const parts=s.args.map(a=>expr.get(a)??a);
        expr.set(s.id,s===p.steps[p.steps.length-1]?parts.join(symbol[s.op]):"("+parts.join(symbol[s.op])+")");
      }
      const estimate=inputs.some(i=>i.estimate||i.owner);
      const provenance:ExplainLine["provenance"]=inputs.some(i=>i.estimate)?"estimate":
        inputs.some(i=>i.owner)?"ownerProvided":"recorded";
      const periods=[...new Set(inputs.map(i=>i.period?i.period.from+"/"+i.period.to:"none"))];
      const period=periods.length===1&&periods[0]!=="none"?inputs[0].period:null;
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
      return {source:"calculate",period,agentId:"leo",missing:[],
        kind:estimate?"estimate":"calculation",purpose:p.purpose,formula:expr.get(run.result.id),
        inputs:inputs.map(i=>({name:i.name,label:i.label,from:i.from,ref:i.ref,unit:unitName[i.value.unit],...shownOf.get(i.name)})),
        steps:run.steps.map(s=>({id:s.id,label:labels.get(s.id),op:s.op,args:s.args,...s.shown})),
        result:{...run.result.shown},
        ...(inputs.some(i=>i.owner)?{ownerProvided:inputs.filter(i=>i.owner).map(i=>i.name)}:{}),
        ...(inputs.some(i=>i.partial)?{basedOnPartialData:inputs.filter(i=>i.partial).map(i=>i.ref.split(":")[0])}:{}),
        explain};
    },
  },
};
