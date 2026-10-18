/** A small, strictly-bounded expression parser/evaluator for the investigation
 * loop's "show your work" formulas (see docs/plan §4b). Grammar is
 * deliberately closed: named variables, numeric literals, and the operators
 * `+ - * / % ( )` only. No function calls, no identifiers beyond the
 * variables the caller declares. Reuses the deterministic rational-number
 * arithmetic already implemented in `./scenarioExpression` instead of
 * reimplementing floating-point-unsafe arithmetic. */
import {rat,plus,minus,times,divided,abs,type Rat} from "./scenarioExpression";

export type FormulaRejectionReason=
  |"empty"|"too_long"|"unknown_character"|"malformed_number"
  |"undeclared_identifier"|"unsupported_grammar"|"too_many_variables"
  |"division_by_zero"|"modulo_by_zero"|"stack_overflow"|"numeric_overflow"
  |"unexpected_end"|"unexpected_token";
export type FormulaEvalResult={ok:true;value:Rat}|{ok:false;reason:FormulaRejectionReason};

const MAX_FORMULA_LENGTH=200;
const MAX_VARIABLES=8;
const MAX_DEPTH=16;

type Token=
  |{type:"num";text:string}
  |{type:"ident";text:string}
  |{type:"op";text:"+"|"-"|"*"|"/"|"%"}
  |{type:"lparen"}|{type:"rparen"};

function tokenize(formula:string):Token[]|null{
  const tokens:Token[]=[];
  let i=0;
  while(i<formula.length){
    const c=formula[i];
    if(/\s/u.test(c)){i++;continue;}
    if(/[0-9]/u.test(c)){
      let j=i+1,dot=false;
      while(j<formula.length&&(/[0-9]/u.test(formula[j])||(!dot&&formula[j]==="."))){
        if(formula[j]===".")dot=true;
        j++;
      }
      tokens.push({type:"num",text:formula.slice(i,j)});
      i=j;continue;
    }
    if(/[a-zA-Z_]/u.test(c)){
      let j=i+1;
      while(j<formula.length&&/[a-zA-Z0-9_]/u.test(formula[j]))j++;
      tokens.push({type:"ident",text:formula.slice(i,j)});
      i=j;continue;
    }
    if(c==="+"||c==="-"||c==="*"||c==="/"||c==="%"){tokens.push({type:"op",text:c});i++;continue;}
    if(c==="("){tokens.push({type:"lparen"});i++;continue;}
    if(c===")"){tokens.push({type:"rparen"});i++;continue;}
    return null;
  }
  return tokens;
}
function parseDecimalToRat(text:string):Rat|null{
  const match=/^([0-9]+)(?:\.([0-9]+))?$/.exec(text);
  if(!match)return null;
  const whole=match[1],frac=match[2]??"";
  const n=BigInt(whole+frac);
  const d=BigInt(10)**BigInt(frac.length);
  return rat(n,d);
}
type ParseState={tokens:Token[];pos:number;depth:number};
type Parsed={ok:true;value:Rat;pos:number}|{ok:false;reason:FormulaRejectionReason};
function parseExpr(state:ParseState,variables:ReadonlyMap<string,Rat>):Parsed{
  const left=parseTerm(state,variables);
  if(!left.ok)return left;
  let pos=left.pos,value=left.value;
  for(;;){
    const token=state.tokens[pos];
    if(!token||token.type!=="op"||(token.text!=="+"&&token.text!=="-"))break;
    const right=parseTerm({...state,pos:pos+1},variables);
    if(!right.ok)return right;
    value=token.text==="+"?plus(value,right.value):minus(value,right.value);
    pos=right.pos;
    if(abs(value.n)>BigInt("1000000000000000")*value.d)return {ok:false,reason:"numeric_overflow"};
  }
  return {ok:true,value,pos};
}
function floorDiv(a:Rat,b:Rat):bigint{
  let n=a.n*b.d,d=a.d*b.n;
  if(d<BigInt("0")){n=-n;d=-d;}
  if(n>=BigInt("0"))return n/d;
  return -(((-n)+d-BigInt("1"))/d);
}
function parseTerm(state:ParseState,variables:ReadonlyMap<string,Rat>):Parsed{
  const left=parseFactor(state,variables);
  if(!left.ok)return left;
  let pos=left.pos,value=left.value;
  for(;;){
    const token=state.tokens[pos];
    if(!token||token.type!=="op"||(token.text!=="*"&&token.text!=="/"&&token.text!=="%"))break;
    const right=parseFactor({...state,pos:pos+1},variables);
    if(!right.ok)return right;
    if(token.text==="*")value=times(value,right.value);
    else if(token.text==="/"){
      if(right.value.n===BigInt("0"))return {ok:false,reason:"division_by_zero"};
      value=divided(value,right.value);
    }else{
      if(right.value.n===BigInt("0"))return {ok:false,reason:"modulo_by_zero"};
      const q=floorDiv(value,right.value);
      value=minus(value,times(rat(q),right.value));
    }
    pos=right.pos;
    if(abs(value.n)>BigInt("1000000000000000")*value.d)return {ok:false,reason:"numeric_overflow"};
  }
  return {ok:true,value,pos};
}
function parseFactor(state:ParseState,variables:ReadonlyMap<string,Rat>):Parsed{
  if(state.depth>MAX_DEPTH)return {ok:false,reason:"stack_overflow"};
  const token=state.tokens[state.pos];
  if(!token)return {ok:false,reason:"unexpected_end"};
  if(token.type==="op"&&token.text==="-"){
    const inner=parseFactor({tokens:state.tokens,pos:state.pos+1,depth:state.depth+1},variables);
    if(!inner.ok)return inner;
    return {ok:true,value:minus(rat(BigInt("0")),inner.value),pos:inner.pos};
  }
  if(token.type==="op"&&token.text==="+"){
    return parseFactor({tokens:state.tokens,pos:state.pos+1,depth:state.depth+1},variables);
  }
  if(token.type==="lparen"){
    const inner=parseExpr({tokens:state.tokens,pos:state.pos+1,depth:state.depth+1},variables);
    if(!inner.ok)return inner;
    const close=state.tokens[inner.pos];
    if(!close||close.type!=="rparen")return {ok:false,reason:"unexpected_token"};
    return {ok:true,value:inner.value,pos:inner.pos+1};
  }
  if(token.type==="num"){
    const value=parseDecimalToRat(token.text);
    if(!value)return {ok:false,reason:"malformed_number"};
    return {ok:true,value,pos:state.pos+1};
  }
  if(token.type==="ident"){
    // No function calls: an identifier immediately followed by "(" is not a
    // variable reference under this grammar.
    const next=state.tokens[state.pos+1];
    if(next&&next.type==="lparen")return {ok:false,reason:"unsupported_grammar"};
    const value=variables.get(token.text);
    if(value===undefined)return {ok:false,reason:"undeclared_identifier"};
    return {ok:true,value,pos:state.pos+1};
  }
  return {ok:false,reason:"unexpected_token"};
}
/** Evaluate `formula` using ONLY the named variables supplied, numeric
 * literals, and `+ - * / % ( )`. Every identifier in the formula must be a
 * key of `variables`; any other identifier, any function-call syntax, and
 * any character outside this closed grammar is rejected rather than
 * evaluated. Never trusts a caller-claimed result -- this always computes
 * the value itself from the supplied (already-verified) variable values. */
export function evaluateFormula(formula:string,variables:ReadonlyMap<string,Rat>):FormulaEvalResult{
  if(typeof formula!=="string"||formula.length===0)return {ok:false,reason:"empty"};
  if(formula.length>MAX_FORMULA_LENGTH)return {ok:false,reason:"too_long"};
  if(variables.size>MAX_VARIABLES)return {ok:false,reason:"too_many_variables"};
  const tokens=tokenize(formula);
  if(!tokens||tokens.length===0)return {ok:false,reason:"unknown_character"};
  const result=parseExpr({tokens,pos:0,depth:0},variables);
  if(!result.ok)return result;
  if(result.pos!==tokens.length)return {ok:false,reason:"unexpected_token"};
  return {ok:true,value:result.value};
}
/** Every bare numeric-literal token in `formula` (e.g. the "999" in
 * "price * 999"). Used by the investigation loop's verifier (Codex finding)
 * to reject a formula containing any constant that was never independently
 * resolved as a variable: a formula may combine as many declared variables
 * as it likes, but every NUMBER in it must trace back to a real, verified
 * source (an owner quote or an observation), never one the model simply
 * wrote into the formula string itself (e.g. "price * 999" with only
 * `price` grounded would otherwise let 999 pass as an unverified
 * multiplier). Returns null, same as a parse failure, only if the formula
 * fails to tokenize at all -- `evaluateFormula`'s own grammar check already
 * catches that case with a proper reason; this is purely an additional,
 * narrower scan over the same tokens. */
export function formulaLiterals(formula:string):string[]|null{
  if(typeof formula!=="string"||formula.length===0||formula.length>MAX_FORMULA_LENGTH)return null;
  const tokens=tokenize(formula);
  if(!tokens)return null;
  return tokens.filter(t=>t.type==="num").map(t=>t.text);
}

/** A deliberately coarse dimension for the investigation loop's formula
 * verifier (lib/ai/supervisor/investigation/formulaVerification.ts) -- just
 * enough to catch semantically-nonsensical arithmetic (adding a unit count
 * to a dollar amount) without reimplementing the registered calculator's
 * full unit system (lib/calc/scenarioExpression.ts). "money" and "percent"
 * mirror the same two kinds `observationDisplay` already classifies raw
 * fields into; every other number (a plain count/quantity, or a dimensionless
 * literal) is "scalar". */
export type ArithmeticUnit="money"|"percent"|"scalar";
export type UnitRejectionReason=FormulaRejectionReason|"incompatible_units";
export type UnitEvalResult={ok:true;unit:ArithmeticUnit}|{ok:false;reason:UnitRejectionReason};

/** Addition/subtraction only make sense between two quantities of the SAME
 * dimension -- a unit count plus a dollar amount is never valid. */
function combineAdd(a:ArithmeticUnit,b:ArithmeticUnit):ArithmeticUnit|null{
  return a===b?a:null;
}
/** A plain scalar freely scales any dimension (3 * $2, a wage * hours-worked
 * counted as a scalar multiplier, etc). A percent applied to money stays
 * money (a 10% discount on $20). Money*money and percent*percent have no
 * sensible单 dimension here and are rejected rather than silently computed. */
function combineMul(a:ArithmeticUnit,b:ArithmeticUnit):ArithmeticUnit|null{
  if(a==="scalar")return b;
  if(b==="scalar")return a;
  if(a==="percent"&&b==="money")return "money";
  if(a==="money"&&b==="percent")return "money";
  return null; // e.g. money*money or percent*percent has no sensible single dimension here
}
/** Dividing by a scalar keeps the dividend's dimension (a total split N
 * ways). Two quantities of the SAME dimension produce a dimensionless ratio
 * (margin = profit/revenue). Money divided by a percent reverses a
 * percentage (a $20 price that is 80% of the original full price). Any
 * other combination (a count divided by a dollar amount, etc.) is rejected. */
function combineDiv(a:ArithmeticUnit,b:ArithmeticUnit):ArithmeticUnit|null{
  if(b==="scalar")return a;
  if(a===b)return "scalar";
  if(a==="money"&&b==="percent")return "money";
  return null;
}
/** Modulo is only ever meaningful between two quantities of the same
 * dimension; reject every mixed case. */
function combineMod(a:ArithmeticUnit,b:ArithmeticUnit):ArithmeticUnit|null{
  return a===b?a:null;
}
type UnitParseState={tokens:Token[];pos:number;depth:number};
type UnitParsed={ok:true;value:ArithmeticUnit;pos:number}|{ok:false;reason:UnitRejectionReason};
function parseExprUnits(state:UnitParseState,units:ReadonlyMap<string,ArithmeticUnit>):UnitParsed{
  const left=parseTermUnits(state,units);
  if(!left.ok)return left;
  let pos=left.pos,value=left.value;
  for(;;){
    const token=state.tokens[pos];
    if(!token||token.type!=="op"||(token.text!=="+"&&token.text!=="-"))break;
    const right=parseTermUnits({...state,pos:pos+1},units);
    if(!right.ok)return right;
    const combined=combineAdd(value,right.value);
    if(!combined)return {ok:false,reason:"incompatible_units"};
    value=combined;pos=right.pos;
  }
  return {ok:true,value,pos};
}
function parseTermUnits(state:UnitParseState,units:ReadonlyMap<string,ArithmeticUnit>):UnitParsed{
  const left=parseFactorUnits(state,units);
  if(!left.ok)return left;
  let pos=left.pos,value=left.value;
  for(;;){
    const token=state.tokens[pos];
    if(!token||token.type!=="op"||(token.text!=="*"&&token.text!=="/"&&token.text!=="%"))break;
    const right=parseFactorUnits({...state,pos:pos+1},units);
    if(!right.ok)return right;
    const combined=token.text==="*"?combineMul(value,right.value):
      token.text==="/"?combineDiv(value,right.value):combineMod(value,right.value);
    if(!combined)return {ok:false,reason:"incompatible_units"};
    value=combined;pos=right.pos;
  }
  return {ok:true,value,pos};
}
function parseFactorUnits(state:UnitParseState,units:ReadonlyMap<string,ArithmeticUnit>):UnitParsed{
  if(state.depth>MAX_DEPTH)return {ok:false,reason:"stack_overflow"};
  const token=state.tokens[state.pos];
  if(!token)return {ok:false,reason:"unexpected_end"};
  if(token.type==="op"&&(token.text==="-"||token.text==="+"))
    return parseFactorUnits({tokens:state.tokens,pos:state.pos+1,depth:state.depth+1},units);
  if(token.type==="lparen"){
    const inner=parseExprUnits({tokens:state.tokens,pos:state.pos+1,depth:state.depth+1},units);
    if(!inner.ok)return inner;
    const close=state.tokens[inner.pos];
    if(!close||close.type!=="rparen")return {ok:false,reason:"unexpected_token"};
    return {ok:true,value:inner.value,pos:inner.pos+1};
  }
  if(token.type==="num")return {ok:true,value:"scalar",pos:state.pos+1};
  if(token.type==="ident"){
    const next=state.tokens[state.pos+1];
    if(next&&next.type==="lparen")return {ok:false,reason:"unsupported_grammar"};
    const value=units.get(token.text);
    if(value===undefined)return {ok:false,reason:"undeclared_identifier"};
    return {ok:true,value,pos:state.pos+1};
  }
  return {ok:false,reason:"unexpected_token"};
}
/** Mirrors `evaluateFormula`'s grammar exactly (same tokenizer, same
 * precedence) but propagates a coarse unit instead of a numeric value,
 * failing closed -- `incompatible_units`, never a thrown error -- on any
 * operation that combines incompatible dimensions (e.g. adding a unit count
 * to a dollar amount). Callers only ever invoke this after `evaluateFormula`
 * already accepted the same formula/variable set, so a grammar-shaped
 * failure here is purely defensive and never expected in practice. */
export function evaluateFormulaUnits(formula:string,units:ReadonlyMap<string,ArithmeticUnit>):UnitEvalResult{
  if(typeof formula!=="string"||formula.length===0)return {ok:false,reason:"empty"};
  if(formula.length>MAX_FORMULA_LENGTH)return {ok:false,reason:"too_long"};
  if(units.size>MAX_VARIABLES)return {ok:false,reason:"too_many_variables"};
  const tokens=tokenize(formula);
  if(!tokens||tokens.length===0)return {ok:false,reason:"unknown_character"};
  const result=parseExprUnits({tokens,pos:0,depth:0},units);
  if(!result.ok)return result;
  if(result.pos!==tokens.length)return {ok:false,reason:"unexpected_token"};
  return {ok:true,unit:result.value};
}

type Scaled={value:Rat;unit:ArithmeticUnit};
type ScaledParsed={ok:true;value:Scaled;pos:number}|{ok:false;reason:UnitRejectionReason};
const HUNDRED=rat(BigInt(100));
/** A percentage is stored, resolved and compared as raw percent-POINTS
 * everywhere in this module (10 for "10%", never 0.10) -- consistent with
 * how an owner writes it and how a basis-points observation pointer is
 * normalized (formulaVerification.ts). But a percentage is only ever a
 * multiplicative RATE, never a raw factor, when it multiplies or divides
 * against a DIFFERENT dimension: "$20 * 10%" means $20 * (10/100) = $2, not
 * $20 * 10 = $200 (Codex finding). combineMul/combineDiv already reject
 * percent*percent and only ever pair percent with money (never scalar,
 * which is left unscaled on purpose -- "3 * 10%" is just "30%", counting
 * rate-units, not a dimension change), so the ONLY two cases needing a
 * scale correction are exactly: multiplying money by percent (divide the
 * raw product by 100), and dividing money BY a percent divisor specifically
 * (multiply the raw quotient by 100 -- "reversing" a percentage, e.g. a $20
 * price that is 80% of the original: 20/(80/100) = 20*100/80, never 20/80). */
function parseExprScaled(state:ParseState,vars:ReadonlyMap<string,Scaled>):ScaledParsed{
  const left=parseTermScaled(state,vars);
  if(!left.ok)return left;
  let pos=left.pos,value=left.value;
  for(;;){
    const token=state.tokens[pos];
    if(!token||token.type!=="op"||(token.text!=="+"&&token.text!=="-"))break;
    const rightResult=parseTermScaled({...state,pos:pos+1},vars);
    if(!rightResult.ok)return rightResult;
    const right=rightResult.value;
    const unit=combineAdd(value.unit,right.unit);
    if(!unit)return {ok:false,reason:"incompatible_units"};
    const v=token.text==="+"?plus(value.value,right.value):minus(value.value,right.value);
    if(abs(v.n)>BigInt("1000000000000000")*v.d)return {ok:false,reason:"numeric_overflow"};
    value={value:v,unit};pos=rightResult.pos;
  }
  return {ok:true,value,pos};
}
function parseTermScaled(state:ParseState,vars:ReadonlyMap<string,Scaled>):ScaledParsed{
  const left=parseFactorScaled(state,vars);
  if(!left.ok)return left;
  let pos=left.pos,value=left.value;
  for(;;){
    const token=state.tokens[pos];
    if(!token||token.type!=="op"||(token.text!=="*"&&token.text!=="/"&&token.text!=="%"))break;
    const rightResult=parseFactorScaled({...state,pos:pos+1},vars);
    if(!rightResult.ok)return rightResult;
    const right=rightResult.value;
    let v:Rat,unit:ArithmeticUnit|null;
    if(token.text==="*"){
      unit=combineMul(value.unit,right.unit);
      if(!unit)return {ok:false,reason:"incompatible_units"};
      v=times(value.value,right.value);
      // Scale ONLY the (money,percent)/(percent,money) combination -- never
      // scalar*percent ("3 * 10%" is "30%", counting rate-units, not a
      // dimension change needing /100; combineMul already allows that case
      // through with no dimension change, same as scalar*money).
      if((value.unit==="money"&&right.unit==="percent")||(value.unit==="percent"&&right.unit==="money"))
        v=divided(v,HUNDRED);
    }else if(token.text==="/"){
      if(right.value.n===BigInt("0"))return {ok:false,reason:"division_by_zero"};
      unit=combineDiv(value.unit,right.unit);
      if(!unit)return {ok:false,reason:"incompatible_units"};
      v=divided(value.value,right.value);
      if(value.unit==="money"&&right.unit==="percent")v=times(v,HUNDRED);
    }else{
      if(right.value.n===BigInt("0"))return {ok:false,reason:"modulo_by_zero"};
      unit=combineMod(value.unit,right.unit);
      if(!unit)return {ok:false,reason:"incompatible_units"};
      const q=floorDiv(value.value,right.value);
      v=minus(value.value,times(rat(q),right.value));
    }
    if(abs(v.n)>BigInt("1000000000000000")*v.d)return {ok:false,reason:"numeric_overflow"};
    value={value:v,unit};pos=rightResult.pos;
  }
  return {ok:true,value,pos};
}
function parseFactorScaled(state:ParseState,vars:ReadonlyMap<string,Scaled>):ScaledParsed{
  if(state.depth>MAX_DEPTH)return {ok:false,reason:"stack_overflow"};
  const token=state.tokens[state.pos];
  if(!token)return {ok:false,reason:"unexpected_end"};
  if(token.type==="op"&&token.text==="-"){
    const inner=parseFactorScaled({tokens:state.tokens,pos:state.pos+1,depth:state.depth+1},vars);
    if(!inner.ok)return inner;
    return {ok:true,value:{value:minus(rat(BigInt("0")),inner.value.value),unit:inner.value.unit},pos:inner.pos};
  }
  if(token.type==="op"&&token.text==="+")
    return parseFactorScaled({tokens:state.tokens,pos:state.pos+1,depth:state.depth+1},vars);
  if(token.type==="lparen"){
    const inner=parseExprScaled({tokens:state.tokens,pos:state.pos+1,depth:state.depth+1},vars);
    if(!inner.ok)return inner;
    const close=state.tokens[inner.pos];
    if(!close||close.type!=="rparen")return {ok:false,reason:"unexpected_token"};
    return {ok:true,value:inner.value,pos:inner.pos+1};
  }
  if(token.type==="num"){
    const v=parseDecimalToRat(token.text);
    if(!v)return {ok:false,reason:"malformed_number"};
    return {ok:true,value:{value:v,unit:"scalar"},pos:state.pos+1};
  }
  if(token.type==="ident"){
    const next=state.tokens[state.pos+1];
    if(next&&next.type==="lparen")return {ok:false,reason:"unsupported_grammar"};
    const value=vars.get(token.text);
    if(value===undefined)return {ok:false,reason:"undeclared_identifier"};
    return {ok:true,value,pos:state.pos+1};
  }
  return {ok:false,reason:"unexpected_token"};
}
/** Combines `evaluateFormula` and `evaluateFormulaUnits` into ONE walk that
 * also applies the percent-as-a-rate scaling described above -- the two
 * separate evaluators can't do this between them, since neither sees both
 * a node's numeric value and its neighbor's unit at the same time. Used by
 * the investigation loop's verifier in place of calling the other two
 * separately. */
export function evaluateFormulaScaled(formula:string,variables:ReadonlyMap<string,Scaled>):
  {ok:true;value:Rat;unit:ArithmeticUnit}|{ok:false;reason:UnitRejectionReason}{
  if(typeof formula!=="string"||formula.length===0)return {ok:false,reason:"empty"};
  if(formula.length>MAX_FORMULA_LENGTH)return {ok:false,reason:"too_long"};
  if(variables.size>MAX_VARIABLES)return {ok:false,reason:"too_many_variables"};
  const tokens=tokenize(formula);
  if(!tokens||tokens.length===0)return {ok:false,reason:"unknown_character"};
  const result=parseExprScaled({tokens,pos:0,depth:0},variables);
  if(!result.ok)return result;
  if(result.pos!==tokens.length)return {ok:false,reason:"unexpected_token"};
  return {ok:true,value:result.value.value,unit:result.value.unit};
}
