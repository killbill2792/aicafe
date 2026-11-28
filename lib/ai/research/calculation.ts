import {CALC_OPS,exactDecimal,runCalculation,type CalcOp,type CalcUnit,type CalcValue} from "@/lib/metrics/core/calculator";

const UNITS=["cents","count","percent","ratio"] as const;
export const calculationToolDefinition={type:"function",name:"calculate",strict:true,
    description:"Exact arithmetic on retrieved values, your derived values, or clearly labeled hypothetical assumptions. Inputs are decimal strings with a unit: cents (money in minor units), count, "+
      "percent (\"12.5\" means 12.5%) or ratio. Steps run in order; each step's args name inputs or earlier steps. "+
      "Ops: add, subtract (2 args), multiply, divide (2 args), sum (any number), percent_of (percent × value).",
    parameters:{type:"object",additionalProperties:false,required:["inputs","steps"],properties:{
      inputs:{type:"array",items:{type:"object",additionalProperties:false,required:["name","value","unit"],properties:{
        name:{type:"string"},value:{type:"string"},unit:{type:"string",enum:[...UNITS]}}}},
      steps:{type:"array",items:{type:"object",additionalProperties:false,required:["id","op","args"],properties:{
        id:{type:"string"},op:{type:"string",enum:[...CALC_OPS]},args:{type:"array",items:{type:"string"}}}}}}}} as const;

/** Exact decimal text of n/d, rounded half away from zero. */
function decimalText(n:bigint,d:bigint,places:number):string{
  const neg=(n<BigInt(0))!==(d<BigInt(0));
  const a=n<BigInt(0)?-n:n,b=d<BigInt(0)?-d:d;
  const scale=BigInt(10)**BigInt(places);
  const q=(a*scale*BigInt(2)+b)/(b*BigInt(2));
  const whole=(q/scale).toString(),frac=(q%scale).toString().padStart(places,"0").replace(/0+$/u,"");
  const text=frac?whole+"."+frac:whole;
  return neg&&/[1-9]/u.test(text)?"-"+text:text;
}
const shownValue=(v:CalcValue)=>v.unit==="percent"?decimalText(v.n*BigInt(100),v.d,6):decimalText(v.n,v.d,6);

export function calculate(input:{inputs:readonly {name:string;value:string;unit:string}[];
  steps:readonly {id:string;op:string;args:readonly string[]}[]}):Record<string,unknown>{
  const values=new Map<string,CalcValue>();
  for(const item of input.inputs){
    if(!(UNITS as readonly string[]).includes(item.unit))return {ok:false,error:"unknown unit for "+item.name};
    const unit=item.unit as CalcUnit;
    const exact=exactDecimal(String(item.value).trim(),unit,unit==="percent"?100:1);
    if(!exact)return {ok:false,error:"input "+item.name+" is not a plain decimal number: "+item.value};
    if(values.has(item.name))return {ok:false,error:"duplicate input name "+item.name};
    values.set(item.name,exact);
  }
  const outcome=runCalculation(values,input.steps.map(s=>({id:s.id,op:s.op as CalcOp,args:s.args})));
  if(!outcome.ok)return {ok:false,error:outcome.code,...(outcome.stepId?{step:outcome.stepId}:{})};
  return {ok:true,
    result:{id:outcome.result.id,value:shownValue(outcome.result.value),unit:outcome.result.value.unit},
    steps:outcome.steps.map(s=>({id:s.id,op:s.op,args:s.args,value:shownValue(s.value),unit:s.value.unit}))};
}

export function executeCalculationTool(args: Record<string, unknown>) {
  try {
    return calculate({inputs:Array.isArray(args.inputs)?args.inputs as never:[],steps:Array.isArray(args.steps)?args.steps as never:[]});
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "tool_failed" };
  }
}
