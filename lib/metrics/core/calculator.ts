/** General calculator for the chat (AGENTS.md 7.2): + − × ÷, sum and percent only.
 * Exact rational math with BigInt; rounding happens only when a value is shown.
 * It has no money definitions: screen numbers come from their own core functions. */

export const DURATION_UNITS=["seconds","minutes","hours","days","weeks","months"] as const;
export type DurationUnit=typeof DURATION_UNITS[number];
export const QUANTITY_UNITS=["g","ml"] as const;
export type QuantityUnit=typeof QUANTITY_UNITS[number];
export const isQuantityUnit=(unit:unknown):unit is QuantityUnit=>QUANTITY_UNITS.some(candidate=>candidate===unit);
export type CalcUnit="cents"|"count"|"percent"|"ratio"|DurationUnit|QuantityUnit;
export const isDurationUnit=(unit:unknown):unit is DurationUnit =>
  DURATION_UNITS.some(candidate=>candidate===unit);
// Calendar months have no fixed duration; calendar days/weeks are separate
// from elapsed hours across timezone transitions.
const durationScale:Record<DurationUnit,bigint>={seconds:BigInt(1),minutes:BigInt(60),hours:BigInt(3600),days:BigInt(1),weeks:BigInt(7),months:BigInt(1)};
const durationFamily=(u:DurationUnit)=>u==="months"?"month":u==="days"||u==="weeks"?"calendar":"elapsed";
export type CalcOp="add"|"subtract"|"multiply"|"divide"|"sum"|"percent_of";
export const CALC_OPS:readonly CalcOp[]=["add","subtract","multiply","divide","sum","percent_of"];

/** An exact value: n/d with d > 0. A percent is stored as a fraction (20% = 1/5). */
export type CalcValue={n:bigint;d:bigint;unit:CalcUnit};
export type CalcStep={id:string;op:CalcOp;args:readonly string[]};
export type CalcShown=
  {unit:"cents";valueCents:number}|{unit:"percent";valueBps:number}|
  {unit:"count";quantity:number}|{unit:"ratio";valueRatio:number}|{unit:DurationUnit;valueDuration:number}|{unit:QuantityUnit;valueQuantity:number};
export type CalcStepResult={id:string;op:CalcOp;args:readonly string[];value:CalcValue;shown:CalcShown};
export type CalcOutcome=
  {ok:true;steps:CalcStepResult[];result:CalcStepResult}|
  {ok:false;code:string;stepId?:string};

const MAX_ABS=BigInt(Number.MAX_SAFE_INTEGER);
// Bound BigInt memory/CPU, not the number of business inputs or steps. A
// normalized 4096-bit rational far exceeds displayed integer-cent precision;
// intermediate products remain at most twice this size before reduction.
const MAX_RATIONAL_BITS=4096;
class ArithmeticResourceLimit extends Error {}
const abs=(x:bigint)=>x<BigInt(0)?-x:x;
const gcd=(a:bigint,b:bigint):bigint=>{a=abs(a);b=abs(b);while(b){[a,b]=[b,a%b];}return a||BigInt(1);};
function make(n:bigint,d:bigint,unit:CalcUnit):CalcValue{
  if(d<BigInt(0)){n=-n;d=-d;}
  const g=gcd(n,d);
  const numerator=n/g,denominator=d/g;
  if(abs(numerator).toString(2).length>MAX_RATIONAL_BITS||denominator.toString(2).length>MAX_RATIONAL_BITS)
    throw new ArithmeticResourceLimit();
  return {n:numerator,d:denominator,unit};
}

/** Exact decimal as returned by PostgreSQL NUMERIC/BIGINT. The model cannot
 * invent these values: the caller must bind them to a verified tool receipt.
 * No Number() conversion, binary float, or unreviewed amount rounding. */
export function exactDecimal(text:string,unit:CalcUnit,scale=1):CalcValue|null{
 if(typeof text!=="string"||
   !/^[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(text)||
   !Number.isSafeInteger(scale)||scale<1)return null;
 const negative=text.startsWith("-");
 const clean=text.replace(/^[+-]/u,"");
 const [whole,fraction=""]=clean.split(".");
 // Strip insignificant zeroes before applying the physical rational bound.
 // Decimal precision is not a business rule; bound BigInt allocation instead.
 const frac=fraction.replace(/0+$/u,"");
 const digits=(whole+frac).replace(/^0+(?=\d)/u,"");
 if(digits.length>MAX_RATIONAL_BITS||frac.length>MAX_RATIONAL_BITS)return null;
 try{
   const numerator=BigInt(digits)*(negative?-BigInt(1):BigInt(1));
   return make(numerator,BigInt(10)**BigInt(frac.length)*BigInt(scale),unit);
 }catch(e){
   if(e instanceof ArithmeticResourceLimit)return null;
   throw e;
 }
}

/** Exact value of a finite JS number, read through its shortest decimal form. */
export function exactNumber(value:number,unit:CalcUnit,scale=1):CalcValue|null{
  if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)return null;
  if(!Number.isSafeInteger(scale)||scale<1)return null;
  const [mantissa,exponent="0"]=String(value).split("e");
  const [whole,frac=""]=mantissa.split(".");
  const power=Number(exponent)-frac.length;
  const digits=BigInt(whole+frac);
  return make(power>=0?digits*BigInt(10)**BigInt(power):digits,
    BigInt(scale)*(power<0?BigInt(10)**BigInt(-power):BigInt(1)),unit);
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
    case "g":case "ml":{const valueQuantity=pick(BigInt(100));return valueQuantity===null?null:{unit:v.unit,valueQuantity};}
    case "seconds":case "minutes":case "hours":case "days":case "weeks":case "months":{
      const valueDuration=pick(BigInt(100));return valueDuration===null?null:{unit:v.unit,valueDuration};
    }
  }
}

const isShare=(u:CalcUnit)=>u==="percent"||u==="ratio";
/** Unit of a × b, or null when the product has no meaning (cents × cents). */
function productUnit(a:CalcUnit,b:CalcUnit):CalcUnit|null{
  if(isQuantityUnit(a)||isQuantityUnit(b)){
    if(isQuantityUnit(a)&&(isShare(b)||b==="count"))return a;
    if(isQuantityUnit(b)&&(isShare(a)||a==="count"))return b;
    return null;
  }
  if(isDurationUnit(a)||isDurationUnit(b)){
    if(isDurationUnit(a)&&(isShare(b)||b==="count"))return a;
    if(isDurationUnit(b)&&(isShare(a)||a==="count"))return b;
    return null;
  }
  if(a==="cents"&&b==="cents")return null;
  if(a==="cents"||b==="cents")return "cents";
  if(a==="count"||b==="count")return "count";
  return a==="percent"&&b==="percent"?"percent":"ratio";
}
/** Unit of a ÷ b. Same units give a share; money ÷ count stays money. */
function quotientUnit(a:CalcUnit,b:CalcUnit):CalcUnit|null{
  if(isQuantityUnit(a)||isQuantityUnit(b)){
    if(isQuantityUnit(a)&&a===b)return "ratio";
    return isQuantityUnit(a)&&(isShare(b)||b==="count")?a:null;
  }
  if(isDurationUnit(a)||isDurationUnit(b)){
    if(isDurationUnit(a)&&isDurationUnit(b))return durationFamily(a)===durationFamily(b)?"ratio":null;
    return isDurationUnit(a)&&(isShare(b)||b==="count")?a:null;
  }
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
    if(isDurationUnit(unit)&&args.every(a=>isDurationUnit(a.unit)&&durationFamily(a.unit)===durationFamily(unit))){
      args=args.map(a=>make(a.n*durationScale[a.unit as DurationUnit],a.d*durationScale[unit],unit));
    }
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
  if(isDurationUnit(a.unit)&&isDurationUnit(b.unit)&&unit==="ratio")
    return make(a.n*b.d*durationScale[a.unit],a.d*b.n*durationScale[b.unit],"ratio");
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
    let value:CalcValue|string;
    try{value=apply(step.op,args);}catch(e){
      if(e instanceof ArithmeticResourceLimit)return {ok:false,code:"arithmeticResourceLimit",stepId:step.id};
      throw e;
    }
    if(typeof value==="string")return {ok:false,code:value,stepId:step.id};
    const display=shown(value);
    if(!display)return {ok:false,code:"valueTooLarge",stepId:step.id};
    known.set(step.id,value);
    out.push({id:step.id,op:step.op,args:step.args,value,shown:display});
  }
  return {ok:true,steps:out,result:out[out.length-1]};
}
