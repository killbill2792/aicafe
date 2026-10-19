import {describe,it,expect} from "vitest";
import {verifyFormulaEntry,findOwnerQuotedSpan} from "./formulaVerification";
import {observationDisplay,type Observation} from "./evidence";
import type {FormulaEntry} from "./protocol";

function observation(id:string,path:string,raw:number,status="verified",input:unknown={}):Observation{
  const result={id:"test.read",status,value:{[path]:raw}};
  const rendered=observationDisplay(result,"en");
  return {id,capabilityId:"p3.test.read.v1",input,result,reference:null,
    display:rendered.display,displayKind:rendered.kind,displayRaw:rendered.raw};
}
const entry=(e:Partial<FormulaEntry>):FormulaEntry=>({claim:"4.83",formula:"a",variables:{a:{value:4.83,source:"$4.83"}},...e});

describe("verifyFormulaEntry -- owner-quoted sources",()=>{
  it("verifies a formula whose inputs are exact owner quotes and whose result matches the claim",()=>{
    const result=verifyFormulaEntry(entry({formula:"a + b",claim:"$4.83",
      variables:{a:{value:3,source:"$3"},b:{value:1.83,source:"$1.83"}}}),
      "Assume $3 and $1.83.",[],"en");
    expect(result).toEqual({ok:true,value:4.83});
  });
  it("rejects a variable whose quoted source does not actually appear in the owner's message",()=>{
    const result=verifyFormulaEntry(entry({variables:{a:{value:4.83,source:"$9.99"}}}),
      "Assume $3 and $1.83.",[],"en");
    expect(result).toEqual({ok:false,failure:{reason:"source_unverifiable",variable:"a"}});
  });
  it("rejects when the recomputed arithmetic does not match the paragraph's stated claim",()=>{
    const result=verifyFormulaEntry(entry({formula:"a + b",claim:"$9.00",
      variables:{a:{value:3,source:"$3"},b:{value:1.83,source:"$1.83"}}}),
      "Assume $3 and $1.83.",[],"en");
    expect(result.ok).toBe(false);
    if(!result.ok)expect(result.failure.reason).toBe("result_mismatch");
  });
});

describe("verifyFormulaEntry -- observation-pointer sources",()=>{
  it("verifies a formula whose input resolves to a real observation's recorded field, normalized to dollars",()=>{
    const o=observation("r1","priceCents",525);
    const result=verifyFormulaEntry(entry({formula:"priceCents",claim:"$5.25",
      variables:{priceCents:{value:525,source:"r1:value.priceCents"}}}),"",[o],"en");
    expect(result).toEqual({ok:true,value:5.25});
  });
  it("rejects a pointer to an observation id that was never produced this turn",()=>{
    const result=verifyFormulaEntry(entry({variables:{a:{value:5.25,source:"r9:value.priceCents"}}}),"",[],"en");
    expect(result).toEqual({ok:false,failure:{reason:"source_not_found",variable:"a"}});
  });
  it("rejects a pointer into an observation that came back unavailable",()=>{
    const o=observation("r1","priceCents",525,"unavailable");
    const result=verifyFormulaEntry(entry({variables:{a:{value:5.25,source:"r1:value.priceCents"}}}),"",[o],"en");
    expect(result).toEqual({ok:false,failure:{reason:"source_not_found",variable:"a"}});
  });
  it("rejects a pointer to a real observation that has no such field",()=>{
    const o=observation("r1","priceCents",525);
    const result=verifyFormulaEntry(entry({variables:{a:{value:5.25,source:"r1:value.otherField"}}}),"",[o],"en");
    expect(result).toEqual({ok:false,failure:{reason:"source_not_found",variable:"a"}});
  });
});

describe("verifyFormulaEntry -- owner-quote matching is exact-boundary, not substring (Codex finding #3)",()=>{
  it("never lets a declared source of \"10\" match inside an owner-written \"100\"",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"10",variables:{a:{value:10,source:"10"}}}),
      "We sold 100 drinks yesterday.",[],"en");
    expect(result).toEqual({ok:false,failure:{reason:"source_unverifiable",variable:"a"}});
  });
  it("matches a legitimately-quoted number even when the owner's formatting differs ($1.45 owner text, 1.45 declared source)",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"$1.45",variables:{a:{value:1.45,source:"1.45"}}}),
      "The special is $1.45 today.",[],"en");
    expect(result).toEqual({ok:true,value:1.45});
  });
  it("requires the typed calculator when the owner did not establish a monetary unit",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"$1.45",variables:{a:{value:1.45,source:"$1.45"}}}),
      "The special is 1.45 today.",[],"en");
    expect(result).toEqual({ok:false,failure:{reason:"requires_registered_calculator"}});
  });
  it("matches an Arabic-Indic numeral owner quote against an ASCII-digit declared source (Codex finding, non-ASCII numerals)",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"100",variables:{a:{value:100,source:"100"}}}),
      "بعنا ١٠٠ مشروب.",[],"ar");
    expect(findOwnerQuotedSpan("بعنا ١٠٠ مشروب.","100","ar")).toBe("١٠٠");
    expect(result).toEqual({ok:false,failure:{reason:"requires_registered_calculator"}});
  });
  it("still never lets a declared source of \"10\" match inside an Arabic-Indic owner-written \"١٠٠\"",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"10",variables:{a:{value:10,source:"10"}}}),
      "بعنا ١٠٠ مشروب.",[],"ar");
    expect(result).toEqual({ok:false,failure:{reason:"source_unverifiable",variable:"a"}});
  });
});

describe("verifyFormulaEntry -- locale-aware decimal separator (Codex finding)",()=>{
  it("reads an es-locale owner's comma as a decimal point, not a thousands grouping character",()=>{
    const result=verifyFormulaEntry(entry({formula:"a + b",claim:"$4,83",
      variables:{a:{value:3,source:"$3"},b:{value:1.83,source:"$1,83"}}}),
      "Sumar $3 y $1,83.",[],"es");
    expect(result).toEqual({ok:true,value:4.83});
  });
  it("never lets an es-locale \"1,61\" (one dollar sixty-one) verify as the integer 161",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"161",variables:{a:{value:161,source:"161"}}}),
      "Vendí a 1,61 cada una.",[],"es");
    expect(result).toEqual({ok:false,failure:{reason:"source_unverifiable",variable:"a"}});
  });
  it("reads the model's own claim text in the same locale, even for a pointer-sourced (locale-independent) value",()=>{
    const o=observation("r1","priceCents",525);
    const result=verifyFormulaEntry(entry({formula:"priceCents",claim:"$5,25",
      variables:{priceCents:{value:525,source:"r1:value.priceCents"}}}),"",[o],"es");
    expect(result).toEqual({ok:true,value:5.25});
  });
});

describe("verifyFormulaEntry -- signed owner numbers keep their sign (Codex finding)",()=>{
  it("never lets a declared positive \"5\" verify against an owner-written negative \"-5\"",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"5",variables:{a:{value:5,source:"5"}}}),
      "Rent alone could cost -5 some months.",[],"en");
    expect(result).toEqual({ok:false,failure:{reason:"source_unverifiable",variable:"a"}});
  });
  it("matches a declared negative source against the owner's own signed figure",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"-5",variables:{a:{value:-5,source:"-5"}}}),
      "Rent alone could cost -5 some months.",[],"en");
    expect(result).toEqual({ok:false,failure:{reason:"requires_registered_calculator"}});
  });
  it("matches a declared negative source written with a currency symbol (\"-$5\")",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"-$5",variables:{a:{value:-5,source:"-$5"}}}),
      "I lost -$5 some months.",[],"en");
    expect(result).toEqual({ok:true,value:-5});
  });
});

describe("verifyFormulaEntry -- unit-aware verification (Codex finding #1)",()=>{
  it("rejects adding a plain unit count to a dollar amount even when the arithmetic is numerically correct",()=>{
    const result=verifyFormulaEntry(entry({formula:"a + b",claim:"5",
      variables:{a:{value:3,source:"3"},b:{value:2,source:"$2"}}}),
      "I sold 3 drinks and spent $2 on supplies.",[],"en");
    expect(result).toEqual({ok:false,failure:{reason:"incompatible_units"}});
  });
  it("routes quantity times unit-price arithmetic through the registered typed calculator",()=>{
    const result=verifyFormulaEntry(entry({formula:"units * price",claim:"4.83",
      variables:{units:{value:3,source:"3"},price:{value:1.61,source:"$1.61"}}}),
      "I sold 3 drinks at $1.61 each.",[],"en");
    expect(result).toEqual({ok:false,failure:{reason:"requires_registered_calculator"}});
  });
  it("rejects adding a plain observation-pointer count to a money-pointer amount",()=>{
    const count=observation("r1","quantitySoldLast28Days",10);
    const price=observation("r2","priceCents",525);
    const result=verifyFormulaEntry(entry({formula:"a + b",claim:"535",
      variables:{a:{value:10,source:"r1:value.quantitySoldLast28Days"},
        b:{value:525,source:"r2:value.priceCents"}}}),"",[count,price],"en");
    expect(result).toEqual({ok:false,failure:{reason:"incompatible_units"}});
  });
});

describe("verifyFormulaEntry -- money/percent pointer values normalized to human scale before combining (Codex finding #2)",()=>{
  it("correctly sums a raw-cents price pointer with a dollar-scale owner quote",()=>{
    const price=observation("r1","priceCents",300);
    const result=verifyFormulaEntry(entry({formula:"price + extra",claim:"$5",
      variables:{price:{value:3,source:"r1:value.priceCents"},extra:{value:2,source:"$2"}}}),
      "Supplies add another $2 on top.",[price],"en");
    expect(result).toEqual({ok:true,value:5});
  });
  it("never lets the SAME naively-scale-confused total (raw cents + dollars, added without conversion) verify just because the model's claim agrees with it",()=>{
    const price=observation("r1","priceCents",300);
    const result=verifyFormulaEntry(entry({formula:"price + extra",claim:"$302",
      variables:{price:{value:300,source:"r1:value.priceCents"},extra:{value:2,source:"$2"}}}),
      "Supplies add another $2 on top.",[price],"en");
    expect(result.ok).toBe(false);
    if(!result.ok)expect(result.failure.reason).toBe("result_mismatch");
  });
  it("normalizes a basis-points rate pointer to percent-points before combining with an owner-quoted percent",()=>{
    const rate=observation("r1","rateBasisPoints",1000);
    const result=verifyFormulaEntry(entry({formula:"rate + extra",claim:"12%",
      variables:{rate:{value:10,source:"r1:value.rateBasisPoints"},extra:{value:2,source:"2%"}}}),
      "Add another 2% on top of the recorded rate.",[rate],"en");
    expect(result).toEqual({ok:true,value:12});
  });
});

describe("verifyFormulaEntry -- rejects any ungrounded numeric literal in the formula itself (Codex finding)",()=>{
  it("never lets a model-invented multiplier with no independent source pass verification",()=>{
    const result=verifyFormulaEntry(entry({formula:"price * 999",claim:"$999",
      variables:{price:{value:1,source:"$1"}}}),"The item costs $1.",[],"en");
    expect(result).toEqual({ok:false,failure:{reason:"ungrounded_literal"}});
  });
  it("never lets a model-invented additive adjustment with no independent source pass verification",()=>{
    const result=verifyFormulaEntry(entry({formula:"price + 10000",claim:"$10001",
      variables:{price:{value:1,source:"$1"}}}),"The item costs $1.",[],"en");
    expect(result).toEqual({ok:false,failure:{reason:"ungrounded_literal"}});
  });
});

describe("verifyFormulaEntry -- percent applied as a multiplicative rate, not a raw factor (Codex finding)",()=>{
  it("scales a percent-points rate by /100 when multiplying against money",()=>{
    const result=verifyFormulaEntry(entry({formula:"price * rate",claim:"$2",
      variables:{price:{value:20,source:"$20"},rate:{value:10,source:"10%"}}}),
      "The $20 price carries a 10% discount.",[],"en");
    expect(result).toEqual({ok:true,value:2});
  });
  it("scales a percent-points rate by *100 when reversing a percentage through division",()=>{
    const result=verifyFormulaEntry(entry({formula:"price / rate",claim:"$25",
      variables:{price:{value:20,source:"$20"},rate:{value:80,source:"80%"}}}),
      "The $20 price is 80% of the original.",[],"en");
    expect(result).toEqual({ok:true,value:25});
  });
  it("never lets the OLD unscaled total ($200 instead of $2) verify",()=>{
    const result=verifyFormulaEntry(entry({formula:"price * rate",claim:"$200",
      variables:{price:{value:20,source:"$20"},rate:{value:10,source:"10%"}}}),
      "The $20 price carries a 10% discount.",[],"en");
    expect(result.ok).toBe(false);
    if(!result.ok)expect(result.failure.reason).toBe("result_mismatch");
  });
  it("routes quantity times percent arithmetic through the registered typed calculator",()=>{
    const result=verifyFormulaEntry(entry({formula:"count * rate",claim:"30%",
      variables:{count:{value:3,source:"3"},rate:{value:10,source:"10%"}}}),
      "Apply the 10% rate 3 times.",[],"en");
    expect(result).toEqual({ok:false,failure:{reason:"requires_registered_calculator"}});
  });
});

describe("findOwnerQuotedSpan -- a hyphenated date/range is never misread as a negative number (Codex finding hardening)",()=>{
  it("still matches an unsigned day-of-month inside a plain ISO date the owner wrote verbatim",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"5",variables:{a:{value:5,source:"5"}}}),
      "We opened on 2026-10-05.",[],"en");
    expect(result).toEqual({ok:false,failure:{reason:"requires_registered_calculator"}});
  });
});

describe("verifyFormulaEntry -- computed result unit must match an explicitly-decorated claim (Codex finding #1)",()=>{
  it("rejects a scalar result (drinks-count plus shift-count) dressed up as a dollar claim",()=>{
    const result=verifyFormulaEntry(entry({formula:"drinks + shifts",claim:"$5",
      variables:{drinks:{value:3,source:"3"},shifts:{value:2,source:"2"}}}),
      "I covered 3 drinks and 2 shifts.",[],"en");
    expect(result).toEqual({ok:false,failure:{reason:"requires_registered_calculator"}});
  });
  it("rejects untyped quantity results even when the claim is undecorated",()=>{
    const result=verifyFormulaEntry(entry({formula:"drinks + shifts",claim:"5",
      variables:{drinks:{value:3,source:"3"},shifts:{value:2,source:"2"}}}),
      "I covered 3 drinks and 2 shifts.",[],"en");
    expect(result).toEqual({ok:false,failure:{reason:"requires_registered_calculator"}});
  });
  it("rejects a scalar result dressed up as a claim whose unit is written as a WORD, not a symbol (Codex finding)",()=>{
    // CLAIM_SPAN (evidence.ts) now folds a trailing currency WORD into the
    // matched claim text, so this reaches verifyFormulaEntry as the full
    // "5 dollars" (not a bare, undecorated "5") -- confirming the result-
    // unit check above actually sees that decoration via classifyOwnerUnit.
    const result=verifyFormulaEntry(entry({formula:"drinks + shifts",claim:"5 dollars",
      variables:{drinks:{value:3,source:"3"},shifts:{value:2,source:"2"}}}),
      "I covered 3 drinks and 2 shifts.",[],"en");
    expect(result).toEqual({ok:false,failure:{reason:"requires_registered_calculator"}});
  });
});

describe("verifyFormulaEntry -- rejects combining data from two different real periods (Codex finding)",()=>{
  it("never lets a formula subtract one period's observation from another's and call it verified",()=>{
    const thisMonth=observation("r1","priceCents",2000,"verified",{period:{from:"2026-10-01",to:"2026-10-18"}});
    const lastMonth=observation("r2","priceCents",1500,"verified",{period:{from:"2026-09-01",to:"2026-09-30"}});
    const result=verifyFormulaEntry(entry({formula:"revenue - cost",claim:"$5",
      variables:{revenue:{value:20,source:"r1:value.priceCents"},cost:{value:15,source:"r2:value.priceCents"}}}),
      "",[thisMonth,lastMonth],"en");
    expect(result).toEqual({ok:false,failure:{reason:"incompatible_periods"}});
  });
  it("still verifies when both pointers share the exact same period",()=>{
    const revenue=observation("r1","priceCents",2000,"verified",{period:{from:"2026-10-01",to:"2026-10-18"}});
    const cost=observation("r2","priceCents",1500,"verified",{period:{from:"2026-10-01",to:"2026-10-18"}});
    const result=verifyFormulaEntry(entry({formula:"revenue - cost",claim:"$5",
      variables:{revenue:{value:20,source:"r1:value.priceCents"},cost:{value:15,source:"r2:value.priceCents"}}}),
      "",[revenue,cost],"en");
    expect(result).toEqual({ok:true,value:5});
  });
  it("rejects an owner quote whose compatibility with a dated pointer is unproven",()=>{
    const revenue=observation("r1","priceCents",2000,"verified",{period:{from:"2026-10-01",to:"2026-10-18"}});
    const result=verifyFormulaEntry(entry({formula:"revenue - extra",claim:"$15",
      variables:{revenue:{value:20,source:"r1:value.priceCents"},extra:{value:5,source:"$5"}}}),
      "I also spent $5 on supplies.",[revenue],"en");
    expect(result).toEqual({ok:false,failure:{reason:"incompatible_periods"}});
  });
});

describe("verifyFormulaEntry -- rejects a sub-cent money claim (Codex finding)",()=>{
  it("never lets an exact sub-cent result ($9.67 / 2 = $4.835) verify, even though it matches the claim precisely",()=>{
    const result=verifyFormulaEntry(entry({formula:"total / split",claim:"$4.835",
      variables:{total:{value:9.67,source:"$9.67"},split:{value:200,source:"200%"}}}),
      "Divide $9.67 by 200%.",[],"en");
    expect(result).toEqual({ok:false,failure:{reason:"sub_cent_precision"}});
  });
  it("still accepts a whole-cent money result even when the claim is written with a trailing zero",()=>{
    const result=verifyFormulaEntry(entry({formula:"price",claim:"$4.830",
      variables:{price:{value:4.83,source:"$4.83"}}}),
      "The price is $4.83.",[],"en");
    expect(result).toEqual({ok:true,value:4.83});
  });
});

describe("verifyFormulaEntry -- grammar failures surface as a specific reason",()=>{
  it("rejects an unsupported grammar instead of silently failing",()=>{
    const result=verifyFormulaEntry(entry({formula:"sum(a)",variables:{a:{value:1,source:"1"}}}),"I have 1 drink.",[],"en");
    expect(result).toEqual({ok:false,failure:{reason:"grammar",detail:"unsupported_grammar"}});
  });
  it("rejects division by zero",()=>{
    const result=verifyFormulaEntry(entry({formula:"a / b",
      variables:{a:{value:1,source:"1"},b:{value:0,source:"0"}}}),"1 over 0.",[],"en");
    expect(result).toEqual({ok:false,failure:{reason:"grammar",detail:"division_by_zero"}});
  });
});

describe("dated owner operands",()=>{
  it.each(["Last month I spent $5.","Hoy gasté $5.","أنفقت $5 الشهر الماضي."])("rejects unknown quote scope: %s",ownerText=>{
    const revenue=observation("r1","priceCents",2000,"verified",{period:{from:"2026-10-18",to:"2026-10-18"}});
    expect(verifyFormulaEntry(entry({formula:"revenue - cost",claim:"$15",variables:{
      revenue:{value:20,source:"r1:value.priceCents"},cost:{value:5,source:"$5"}}}),ownerText,[revenue],"en"))
      .toEqual({ok:false,failure:{reason:"incompatible_periods"}});
  });
});

describe("currency and monetary subunits",()=>{
  it("keeps cents on their real dollar scale",()=>{
    expect(verifyFormulaEntry(entry({claim:"$0.05",formula:"a",variables:{a:{value:5,source:"5 cents"}}}),
      "Assume 5 cents.",[],"en")).toEqual({ok:true,value:0.05});
  });
  it("rejects adding different currencies",()=>{
    expect(verifyFormulaEntry(entry({claim:"$10",formula:"a + b",variables:{
      a:{value:5,source:"$5"},b:{value:5,source:"€5"}}}),"Assume $5 and €5.",[],"en"))
      .toEqual({ok:false,failure:{reason:"incompatible_units"}});
  });
  it("rejects relabeling euros as dollars",()=>{
    expect(verifyFormulaEntry(entry({claim:"$5",formula:"a",variables:{a:{value:5,source:"€5"}}}),
      "Assume €5.",[],"en")).toEqual({ok:false,failure:{reason:"incompatible_units"}});
  });
});

describe("PR127 second-review source boundaries",()=>{
  it("never invents an operand's money dimension from model source decoration",()=>{
    expect(verifyFormulaEntry(entry({claim:"$10",formula:"a + a",variables:{a:{value:5,source:"$5"}}}),
      "I have 5 employees.",[],"en")).toEqual({ok:false,failure:{reason:"requires_registered_calculator"}});
  });
  it.each(["25 dollars","610 dollars","1 dollar"])("rejects a fragment of an Arabic-formatted owner amount: %s",source=>{
    expect(verifyFormulaEntry(entry({claim:"25",formula:"a",variables:{a:{value:25,source}}}),
      "السعر ١٬٦١٠٫٢٥ دولار.",[],"ar")).toEqual({ok:false,failure:{reason:"source_unverifiable",variable:"a"}});
  });
  it.each(["ar","en","es"] as const)("reads Arabic grouping/decimal punctuation as a whole amount in %s",locale=>{
    const text=locale==="es"?"1610,25":"1610.25";
    expect(verifyFormulaEntry(entry({claim:"$"+text,formula:"a",variables:{a:{value:1610.25,source:text}}}),
      "السعر ١٬٦١٠٫٢٥ دولار.",[],locale)).toEqual({ok:true,value:1610.25});
  });
  it("rejects an unused pointer declaration",()=>{
    const source=observation("r2","priceCents",1000);
    expect(verifyFormulaEntry(entry({claim:"$5",formula:"a",variables:{
      a:{value:5,source:"$5"},b:{value:10,source:"r2:value.priceCents"}}}),"Assume $5.",[source],"en"))
      .toEqual({ok:false,failure:{reason:"unused_variable",variable:"b"}});
  });
});

describe("self-review: leading decimals and spaced negative signs",()=>{
  it.each([".50 dollars","٫٥٠ دولار"])("does not authorize a fifty-dollar echo from %s",owner=>{
    expect(findOwnerQuotedSpan(owner,"50 dollars","en")).toBeNull();
    expect(findOwnerQuotedSpan(owner,"$0.50","en")).not.toBeNull();
  });
  it("preserves a Spanish leading decimal",()=>{
    expect(findOwnerQuotedSpan(",50 dólares","50 dólares","es")).toBeNull();
    expect(findOwnerQuotedSpan(",50 dólares","0,50 dólares","es")).not.toBeNull();
  });
  it.each(["- $5","$-5","$ - 5"])("does not authorize a positive echo from %s",owner=>{
    expect(findOwnerQuotedSpan(owner,"$5","en")).toBeNull();
    expect(findOwnerQuotedSpan(owner,"-$5","en")).not.toBeNull();
  });
});

describe("third review: scheduling scope and leading decimals",()=>{
  it.each([false,true])("rejects money combined across schedule weeks (nested=%s)",nested=>{
    const scope=(week:string)=>nested?{request:{week}}:{week};
    const a=observation("r1","priceCents",1000,"verified",scope("2026-10-19"));
    const b=observation("r2","priceCents",500,"verified",scope("2026-10-26"));
    expect(verifyFormulaEntry(entry({claim:"$5",formula:"a - b",variables:{
      a:{value:10,source:"r1:value.priceCents"},b:{value:5,source:"r2:value.priceCents"}}}),"",[a,b],"en"))
      .toEqual({ok:false,failure:{reason:"incompatible_periods"}});
  });
  it("accepts matching weeks through top-level and nested readers",()=>{
    const a=observation("r1","priceCents",1000,"verified",{week:"2026-10-19"});
    const b=observation("r2","priceCents",500,"verified",{request:{week:"2026-10-19"}});
    expect(verifyFormulaEntry(entry({claim:"$5",formula:"a - b",variables:{
      a:{value:10,source:"r1:value.priceCents"},b:{value:5,source:"r2:value.priceCents"}}}),"",[a,b],"en"))
      .toEqual({ok:true,value:5});
  });
  it("rejects owner quotes mixed with week-scoped data",()=>{
    const a=observation("r1","priceCents",1000,"verified",{request:{week:"2026-10-19"}});
    expect(verifyFormulaEntry(entry({claim:"$5",formula:"a - b",variables:{
      a:{value:10,source:"r1:value.priceCents"},b:{value:5,source:"$5"}}}),"Last week $5.",[a],"en"))
      .toEqual({ok:false,failure:{reason:"incompatible_periods"}});
  });
  it("preserves a dot-leading amount in Spanish rather than inflating it",()=>{
    expect(findOwnerQuotedSpan(".50 dollars","50 dollars","es")).toBeNull();
    expect(verifyFormulaEntry(entry({claim:"$0,50",formula:"a",variables:{a:{value:0.5,source:".50 dollars"}}}),
      ".50 dollars",[],"es")).toEqual({ok:true,value:0.5});
  });
  it("requires registered quantity arithmetic rather than adding drinks to shifts",()=>{
    expect(verifyFormulaEntry(entry({claim:"5",formula:"drinks + shifts",variables:{
      drinks:{value:3,source:"3"},shifts:{value:2,source:"2"}}}),"3 drinks and 2 shifts",[],"en"))
      .toEqual({ok:false,failure:{reason:"requires_registered_calculator"}});
  });
});


describe("PR127 derived period lineage and Unicode sign regressions",()=>{
  function money(id:string,cents:number,input:unknown={}):Observation{
    return observation(id,"priceCents",cents,"verified",input);
  }
  function dataset(id:string,sourceReadId:string,cents:number):Observation{
    const result={id:"platform.dataset.analysis",status:"partial",
      value:{groups:[{group:null,value:cents}],unit:"USD_cents",sourceReadId,operation:"sum",field:"priceCents"}};
    const displayed=observationDisplay(result,"en");
    return {id,capabilityId:"p3.platform.dataset.analysis.v1",input:{readId:sourceReadId},result,reference:null,
      display:displayed.display,displayKind:displayed.kind,displayRaw:displayed.raw};
  }
  it("rejects a derived monthly total combined with a pointer from another month",()=>{
    const october=money("r1",1000,{period:{from:"2026-10-01",to:"2026-10-31"}});
    const sum=dataset("r2","r1",1000);
    const september=money("r3",500,{period:{from:"2026-09-01",to:"2026-09-30"}});
    const actual=verifyFormulaEntry(entry({claim:"$5",formula:"a - b",variables:{
      a:{value:10,source:"r2:value.groups.0.value"},b:{value:5,source:"r3:value.priceCents"}
    }}),"",[october,sum,september],"en");
    expect(actual).toEqual({ok:false,failure:{reason:"incompatible_periods"}});
  });
  it("allows a derived result and direct read within the same month",()=>{
    const period={period:{from:"2026-10-01",to:"2026-10-31"}};
    const read=money("r1",1000,period);
    const sum=dataset("r2","r1",1000);
    const other=money("r3",500,period);
    expect(verifyFormulaEntry(entry({claim:"$5",formula:"a - b",variables:{
      a:{value:10,source:"r2:value.groups.0.value"},b:{value:5,source:"r3:value.priceCents"}
    }}),"",[read,sum,other],"en")).toEqual({ok:true,value:5});
  });
  it("rejects a derived result whose referenced source is missing",()=>{
    const sum=dataset("r2","r99",1000);
    expect(verifyFormulaEntry(entry({claim:"$10",formula:"a",variables:{
      a:{value:10,source:"r2:value.groups.0.value"}
    }}),"",[sum],"en").ok).toBe(false);
  });
  it.each(["−$5","﹣$5","－$5"])("treats %s as a negative owner amount, never positive",owner=>{
    expect(findOwnerQuotedSpan(owner,"$5","en")).toBeNull();
    expect(findOwnerQuotedSpan(owner,"-$5","en")).not.toBeNull();
  });
});
