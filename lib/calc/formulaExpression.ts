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
