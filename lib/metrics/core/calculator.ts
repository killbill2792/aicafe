/** General calculator for the chat (AGENTS.md 7.2): + − × ÷, sum and percent only.
 * Exact rational math with BigInt; rounding happens only when a value is shown.
 * It has no money definitions: screen numbers come from their own core functions. */

export type CalcUnit="cents"|"count"|"percent"|"ratio";
export type CalcOp="add"|"subtract"|"multiply"|"divide"|"sum"|"percent_of";
export const CALC_OPS:readonly CalcOp[]=["add","subtract","multiply","divide","sum","percent_of"];

/** An exact value: n/d with d > 0. A percent is stored as a fraction (20% = 1/5). */
export type CalcValue={n:bigint;d:bigint;unit:CalcUnit};
export type CalcStep={id:string;op:CalcOp;args:readonly string[]};
export type CalcShown=
  {unit:"cents";valueCents:number}|{unit:"percent";valueBps:number}|
  {unit:"count";quantity:number}|{unit:"ratio";valueRatio:number};
export type CalcStepResult={id:string;op:CalcOp;args:readonly string[];value:CalcValue;shown:CalcShown};
export type CalcOutcome=
  {ok:true;steps:CalcStepResult[];result:CalcStepResult}|
  {ok:false;code:string;stepId?:string};

const MAX_ABS=BigInt(Number.MAX_SAFE_INTEGER);
const abs=(x:bigint)=>x<BigInt(0)?-x:x;
const gcd=(a:bigint,b:bigint):bigint=>{a=abs(a);b=abs(b);while(b){[a,b]=[b,a%b];}return a||BigInt(1);};
function make(n:bigint,d:bigint,unit:CalcUnit):CalcValue{
  if(d<BigInt(0)){n=-n;d=-d;}
  const g=gcd(n,d);
  return {n:n/g,d:d/g,unit};
}

/** Exact value of a finite JS number, read through its shortest decimal form. */
export function exactNumber(value:number,unit:CalcUnit,scale=1):CalcValue|null{
  if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)return null;
  const text=value.toFixed(10).replace(/0+$/u,"").replace(/\.$/u,"");
  const [whole,frac=""]=text.split(".");
  const d=BigInt(10)**BigInt(frac.length)*BigInt(scale);
  return make(BigInt(whole+frac),d,unit);
}

/** Round half away from zero to the nearest multiple of 1/per. */
function roundTo(v:CalcValue,per:bigint):bigint{
  const scaled=v.n*per,neg=scaled<BigInt(0),a=abs(scaled);
  const q=(a*BigInt(2)+v.d)/(v.d*BigInt(2));
  return neg?-q:q;
}
function shown(v:CalcValue):CalcShown|null{
  const pick=(per:bigint)=>{const r=roundTo(v,per);return abs(r)>MAX_ABS?null:Number(r)/Number(per);};
  switch(v.unit){
    case "cents":{const c=pick(BigInt(1));return c===null?null:{unit:"cents",valueCents:c};}
    case "percent":{const b=roundTo(v,BigInt(10000));return abs(b)>MAX_ABS?null:{unit:"percent",valueBps:Number(b)};}
    case "count":{const q=pick(BigInt(100));return q===null?null:{unit:"count",quantity:q};}
    case "ratio":{const r=pick(BigInt(10000));return r===null?null:{unit:"ratio",valueRatio:r};}
  }
}

const isShare=(u:CalcUnit)=>u==="percent"||u==="ratio";
/** Unit of a × b, or null when the product has no meaning (cents × cents). */
function productUnit(a:CalcUnit,b:CalcUnit):CalcUnit|null{
  if(a==="cents"&&b==="cents")return null;
  if(a==="cents"||b==="cents")return "cents";
  if(a==="count"||b==="count")return "count";
  return a==="percent"&&b==="percent"?"percent":"ratio";
}
/** Unit of a ÷ b. Same units give a share; money ÷ count stays money. */
function quotientUnit(a:CalcUnit,b:CalcUnit):CalcUnit|null{
  if(a===b)return a==="cents"?"percent":a==="count"?"ratio":"ratio";
  if(b==="cents")return null;
  if(a==="cents")return "cents";
  if(a==="count")return "count";
  return isShare(a)&&isShare(b)?"ratio":null;
}

function apply(op:CalcOp,args:CalcValue[]):CalcValue|string{
  if(op==="sum"||op==="add"||op==="subtract"){
    if(op!=="sum"&&args.length!==2)return "needsTwoArgs";
    if(!args.length)return "needsArgs";
    const unit=args[0].unit;
    if(args.some(a=>a.unit!==unit&&!(isShare(a.unit)&&isShare(unit))))return "unitsDiffer";
    if(op==="subtract")return make(args[0].n*args[1].d-args[1].n*args[0].d,args[0].d*args[1].d,unit);
    return args.slice(1).reduce((acc,a)=>make(acc.n*a.d+a.n*acc.d,acc.d*a.d,unit),args[0]);
  }
  if(args.length!==2)return "needsTwoArgs";
  const [a,b]=args;
  if(op==="percent_of"){
    if(a.unit!=="percent")return "firstArgMustBePercent";
    const unit=productUnit(a.unit,b.unit);
    return unit?make(a.n*b.n,a.d*b.d,unit):"unitsCannotMultiply";
  }
  if(op==="multiply"){
    const unit=productUnit(a.unit,b.unit);
    return unit?make(a.n*b.n,a.d*b.d,unit):"unitsCannotMultiply";
  }
  if(b.n===BigInt(0))return "divideByZero";
  const unit=quotientUnit(a.unit,b.unit);
  return unit?make(a.n*b.d,a.d*b.n,unit):"unitsCannotDivide";
}

/** Run steps in order. Each arg names an input or an earlier step. Fails closed:
 * an unknown name, a unit mismatch or a value too large stops the calculation. */
export function runCalculation(inputs:ReadonlyMap<string,CalcValue>,steps:readonly CalcStep[]):CalcOutcome{
  if(!steps.length)return {ok:false,code:"noSteps"};
  const known=new Map(inputs);
  const out:CalcStepResult[]=[];
  for(const step of steps){
    if(known.has(step.id))return {ok:false,code:"duplicateName",stepId:step.id};
    if(!CALC_OPS.includes(step.op))return {ok:false,code:"unknownOp",stepId:step.id};
    const args:CalcValue[]=[];
    for(const name of step.args){
      const value=known.get(name);
      if(!value)return {ok:false,code:"unknownArg:"+name,stepId:step.id};
      args.push(value);
    }
    const value=apply(step.op,args);
    if(typeof value==="string")return {ok:false,code:value,stepId:step.id};
    const display=shown(value);
    if(!display)return {ok:false,code:"valueTooLarge",stepId:step.id};
    known.set(step.id,value);
    out.push({id:step.id,op:step.op,args:step.args,value,shown:display});
  }
  return {ok:true,steps:out,result:out[out.length-1]};
}
