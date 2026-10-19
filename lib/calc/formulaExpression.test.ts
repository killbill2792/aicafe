import {describe,it,expect} from "vitest";
import {evaluateFormula,evaluateFormulaUnits,evaluateFormulaScaled,formulaLiterals,
  type ArithmeticUnit} from "./formulaExpression";
import {rat} from "./scenarioExpression";

const vars=(entries:Record<string,number>)=>
  new Map(Object.entries(entries).map(([k,v])=>[k,rat(BigInt(v))] as const));
const value=(r:{ok:true;value:{n:bigint;d:bigint}})=>Number(r.value.n)/Number(r.value.d);
const units=(entries:Record<string,ArithmeticUnit>)=>new Map(Object.entries(entries));
const scaledVars=(entries:Record<string,[number,ArithmeticUnit]>)=>new Map(Object.entries(entries)
  .map(([k,[v,unit]])=>[k,{value:rat(BigInt(v)),unit}] as const));

describe("evaluateFormula -- accepted grammar",()=>{
  it("evaluates a simple multiplication of two variables",()=>{
    const result=evaluateFormula("unitsSold * pricePerUnit",vars({unitsSold:3,pricePerUnit:483}));
    expect(result.ok).toBe(true);
    if(result.ok)expect(value(result)).toBe(1449);
  });
  it("respects operator precedence (multiply before add)",()=>{
    const result=evaluateFormula("a + b * c",vars({a:1,b:2,c:3}));
    expect(result.ok).toBe(true);
    if(result.ok)expect(value(result)).toBe(7);
  });
  it("respects parentheses to override precedence",()=>{
    const result=evaluateFormula("(a + b) * c",vars({a:1,b:2,c:3}));
    expect(result.ok).toBe(true);
    if(result.ok)expect(value(result)).toBe(9);
  });
  it("supports division",()=>{
    const result=evaluateFormula("revenue / units",vars({revenue:900,units:4}));
    expect(result.ok).toBe(true);
    if(result.ok)expect(value(result)).toBe(225);
  });
  it("supports modulo",()=>{
    const result=evaluateFormula("a % b",vars({a:10,b:3}));
    expect(result.ok).toBe(true);
    if(result.ok)expect(value(result)).toBe(1);
  });
  it("supports unary minus and negative results",()=>{
    const result=evaluateFormula("-a + b",vars({a:5,b:2}));
    expect(result.ok).toBe(true);
    if(result.ok)expect(value(result)).toBe(-3);
  });
  it("supports decimal literals exactly, without float drift",()=>{
    const result=evaluateFormula("price - 1.45",vars({price:3}));
    expect(result.ok).toBe(true);
    if(result.ok)expect(value(result)).toBeCloseTo(1.55,10);
  });
  it("tolerates internal whitespace",()=>{
    const result=evaluateFormula("  a   +   b  ",vars({a:1,b:1}));
    expect(result.ok).toBe(true);
    if(result.ok)expect(value(result)).toBe(2);
  });
});

describe("evaluateFormula -- rejected grammar",()=>{
  it("rejects an empty formula",()=>{
    expect(evaluateFormula("",vars({}))).toEqual({ok:false,reason:"empty"});
  });
  it("rejects an undeclared identifier",()=>{
    const result=evaluateFormula("a + b",vars({a:1}));
    expect(result).toEqual({ok:false,reason:"undeclared_identifier"});
  });
  it("rejects function-call syntax",()=>{
    const result=evaluateFormula("sum(a)",vars({a:1,sum:0}));
    expect(result.ok).toBe(false);
    if(!result.ok)expect(result.reason).toBe("unsupported_grammar");
  });
  it("rejects an unknown character",()=>{
    const result=evaluateFormula("a + b^2",vars({a:1,b:2}));
    expect(result).toEqual({ok:false,reason:"unknown_character"});
  });
  it("rejects division by zero",()=>{
    const result=evaluateFormula("a / b",vars({a:1,b:0}));
    expect(result).toEqual({ok:false,reason:"division_by_zero"});
  });
  it("rejects modulo by zero",()=>{
    const result=evaluateFormula("a % b",vars({a:1,b:0}));
    expect(result).toEqual({ok:false,reason:"modulo_by_zero"});
  });
  it("rejects a dangling operator",()=>{
    const result=evaluateFormula("a +",vars({a:1}));
    expect(result.ok).toBe(false);
  });
  it("rejects unbalanced parentheses",()=>{
    const result=evaluateFormula("(a + b",vars({a:1,b:2}));
    expect(result.ok).toBe(false);
  });
  it("rejects trailing tokens after a complete expression",()=>{
    const result=evaluateFormula("a + b )",vars({a:1,b:2}));
    expect(result.ok).toBe(false);
  });
  it("rejects more than the maximum number of variables",()=>{
    const entries=Object.fromEntries(Array.from({length:9},(_,i)=>["v"+i,1]));
    const formula=Object.keys(entries).join("+");
    const result=evaluateFormula(formula,vars(entries));
    expect(result).toEqual({ok:false,reason:"too_many_variables"});
  });
  it("rejects a formula longer than the maximum length",()=>{
    const result=evaluateFormula("a+".repeat(150)+"a",vars({a:1}));
    expect(result).toEqual({ok:false,reason:"too_long"});
  });
});

describe("evaluateFormulaUnits -- coarse unit-compatibility checking",()=>{
  it("accepts a scalar multiplied by a money amount, yielding money",()=>{
    const result=evaluateFormulaUnits("unitsSold * pricePerUnit",units({unitsSold:"scalar",pricePerUnit:"money"}));
    expect(result).toEqual({ok:true,unit:"money"});
  });
  it("accepts money plus money, yielding money",()=>{
    const result=evaluateFormulaUnits("a + b",units({a:"money",b:"money"}));
    expect(result).toEqual({ok:true,unit:"money"});
  });
  it("rejects adding a scalar count to a money amount",()=>{
    const result=evaluateFormulaUnits("a + b",units({a:"scalar",b:"money"}));
    expect(result).toEqual({ok:false,reason:"incompatible_units"});
  });
  it("rejects adding a percent to a money amount",()=>{
    const result=evaluateFormulaUnits("a + b",units({a:"percent",b:"money"}));
    expect(result).toEqual({ok:false,reason:"incompatible_units"});
  });
  it("accepts money divided by money, yielding a dimensionless scalar ratio",()=>{
    const result=evaluateFormulaUnits("profit / revenue",units({profit:"money",revenue:"money"}));
    expect(result).toEqual({ok:true,unit:"scalar"});
  });
  it("rejects multiplying two money amounts together",()=>{
    const result=evaluateFormulaUnits("a * b",units({a:"money",b:"money"}));
    expect(result).toEqual({ok:false,reason:"incompatible_units"});
  });
  it("propagates the failure through parentheses and nested operators",()=>{
    const result=evaluateFormulaUnits("(a + b) * c",units({a:"scalar",b:"money",c:"scalar"}));
    expect(result).toEqual({ok:false,reason:"incompatible_units"});
  });
});

describe("formulaLiterals -- every bare numeric-literal token (Codex finding)",()=>{
  it("finds no literals in a formula built entirely from variables",()=>{
    expect(formulaLiterals("unitsSold * pricePerUnit")).toEqual([]);
  });
  it("finds a single literal mixed in with variables",()=>{
    expect(formulaLiterals("price * 999")).toEqual(["999"]);
  });
  it("finds every literal, including a decimal one, across the whole formula",()=>{
    expect(formulaLiterals("a + 1.45 - 2")).toEqual(["1.45","2"]);
  });
  it("returns null, same as a parse failure, for a formula that cannot tokenize",()=>{
    expect(formulaLiterals("a + b^2")).toBeNull();
  });
});

describe("evaluateFormulaScaled -- combined value+unit evaluation with percent-as-a-rate scaling (Codex finding)",()=>{
  it("matches evaluateFormula's plain arithmetic when no percent is involved",()=>{
    const result=evaluateFormulaScaled("unitsSold * pricePerUnit",
      scaledVars({unitsSold:[3,"scalar"],pricePerUnit:[483,"money"]}));
    expect(result.ok).toBe(true);
    if(result.ok){expect(Number(result.value.n)/Number(result.value.d)).toBe(1449);expect(result.unit).toBe("money");}
  });
  it("scales a percent-points rate by /100 when multiplying against money (not a raw factor)",()=>{
    const result=evaluateFormulaScaled("price * rate",scaledVars({price:[20,"money"],rate:[10,"percent"]}));
    expect(result.ok).toBe(true);
    if(result.ok){expect(Number(result.value.n)/Number(result.value.d)).toBe(2);expect(result.unit).toBe("money");}
  });
  it("scales a percent-points divisor by *100 when reversing a percentage through division",()=>{
    const result=evaluateFormulaScaled("price / rate",scaledVars({price:[20,"money"],rate:[80,"percent"]}));
    expect(result.ok).toBe(true);
    if(result.ok){expect(Number(result.value.n)/Number(result.value.d)).toBe(25);expect(result.unit).toBe("money");}
  });
  it("does NOT scale a scalar multiplied by a percent (counting rate-units, not a dimension change)",()=>{
    const result=evaluateFormulaScaled("count * rate",scaledVars({count:[3,"scalar"],rate:[10,"percent"]}));
    expect(result.ok).toBe(true);
    if(result.ok){expect(Number(result.value.n)/Number(result.value.d)).toBe(30);expect(result.unit).toBe("percent");}
  });
  it("does NOT scale a same-dimension ratio (percent divided by percent)",()=>{
    const result=evaluateFormulaScaled("a / b",scaledVars({a:[5,"percent"],b:[20,"percent"]}));
    expect(result.ok).toBe(true);
    if(result.ok){expect(Number(result.value.n)/Number(result.value.d)).toBe(0.25);expect(result.unit).toBe("scalar");}
  });
  it("still rejects incompatible dimensions exactly like evaluateFormulaUnits",()=>{
    const result=evaluateFormulaScaled("a + b",scaledVars({a:[3,"scalar"],b:[2,"money"]}));
    expect(result).toEqual({ok:false,reason:"incompatible_units"});
  });
});
