import {describe,it,expect} from "vitest";
import {verifyFormulaEntry} from "./formulaVerification";
import {observationDisplay,type Observation} from "./evidence";
import type {FormulaEntry} from "./protocol";

function observation(id:string,path:string,raw:number,status="verified"):Observation{
  const result={id:"test.read",status,value:{[path]:raw}};
  const rendered=observationDisplay(result,"en");
  return {id,capabilityId:"p3.test.read.v1",input:{},result,reference:null,
    display:rendered.display,displayKind:rendered.kind,displayRaw:rendered.raw};
}
const entry=(e:Partial<FormulaEntry>):FormulaEntry=>({claim:"4.83",formula:"a",variables:{a:{value:4.83,source:"$4.83"}},...e});

describe("verifyFormulaEntry -- owner-quoted sources",()=>{
  it("verifies a formula whose inputs are exact owner quotes and whose result matches the claim",()=>{
    const result=verifyFormulaEntry(entry({formula:"unitsSold * pricePerUnit",claim:"4.83",
      variables:{unitsSold:{value:3,source:"3"},pricePerUnit:{value:1.61,source:"$1.61"}}}),
      "I sold 3 drinks at $1.61 each.",[],"en");
    expect(result).toEqual({ok:true,value:4.83});
  });
  it("rejects a variable whose quoted source does not actually appear in the owner's message",()=>{
    const result=verifyFormulaEntry(entry({variables:{a:{value:4.83,source:"$9.99"}}}),
      "I sold 3 drinks at $1.61 each.",[],"en");
    expect(result).toEqual({ok:false,failure:{reason:"source_unverifiable",variable:"a"}});
  });
  it("rejects when the recomputed arithmetic does not match the paragraph's stated claim",()=>{
    const result=verifyFormulaEntry(entry({formula:"unitsSold * pricePerUnit",claim:"9.00",
      variables:{unitsSold:{value:3,source:"3"},pricePerUnit:{value:1.61,source:"$1.61"}}}),
      "I sold 3 drinks at $1.61 each.",[],"en");
    expect(result.ok).toBe(false);
    if(!result.ok)expect(result.failure.reason).toBe("result_mismatch");
  });
});

describe("verifyFormulaEntry -- observation-pointer sources",()=>{
  it("verifies a formula whose input resolves to a real observation's recorded field, normalized to dollars",()=>{
    const o=observation("r1","priceCents",525);
    const result=verifyFormulaEntry(entry({formula:"priceCents",claim:"5.25",
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
    const result=verifyFormulaEntry(entry({formula:"a",claim:"1.45",variables:{a:{value:1.45,source:"1.45"}}}),
      "The special is $1.45 today.",[],"en");
    expect(result).toEqual({ok:true,value:1.45});
  });
  it("matches a legitimately-quoted number in the other direction (1.45 owner text, $1.45 declared source)",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"1.45",variables:{a:{value:1.45,source:"$1.45"}}}),
      "The special is 1.45 today.",[],"en");
    expect(result).toEqual({ok:true,value:1.45});
  });
  it("matches an Arabic-Indic numeral owner quote against an ASCII-digit declared source (Codex finding, non-ASCII numerals)",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"100",variables:{a:{value:100,source:"100"}}}),
      "بعنا ١٠٠ مشروب.",[],"ar");
    expect(result).toEqual({ok:true,value:100});
  });
  it("still never lets a declared source of \"10\" match inside an Arabic-Indic owner-written \"١٠٠\"",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"10",variables:{a:{value:10,source:"10"}}}),
      "بعنا ١٠٠ مشروب.",[],"ar");
    expect(result).toEqual({ok:false,failure:{reason:"source_unverifiable",variable:"a"}});
  });
});

describe("verifyFormulaEntry -- locale-aware decimal separator (Codex finding)",()=>{
  it("reads an es-locale owner's comma as a decimal point, not a thousands grouping character",()=>{
    const result=verifyFormulaEntry(entry({formula:"unitsSold * pricePerUnit",claim:"4,83",
      variables:{unitsSold:{value:3,source:"3"},pricePerUnit:{value:1.61,source:"1,61"}}}),
      "Vendí 3 bebidas a 1,61 cada una.",[],"es");
    expect(result).toEqual({ok:true,value:4.83});
  });
  it("never lets an es-locale \"1,61\" (one dollar sixty-one) verify as the integer 161",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"161",variables:{a:{value:161,source:"161"}}}),
      "Vendí a 1,61 cada una.",[],"es");
    expect(result).toEqual({ok:false,failure:{reason:"source_unverifiable",variable:"a"}});
  });
  it("reads the model's own claim text in the same locale, even for a pointer-sourced (locale-independent) value",()=>{
    const o=observation("r1","priceCents",525);
    const result=verifyFormulaEntry(entry({formula:"priceCents",claim:"5,25",
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
    expect(result).toEqual({ok:true,value:-5});
  });
  it("matches a declared negative source written with a currency symbol (\"-$5\")",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"-5",variables:{a:{value:-5,source:"-$5"}}}),
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
  it("still accepts a scalar multiplied by a money amount (a unit price times a quantity)",()=>{
    const result=verifyFormulaEntry(entry({formula:"units * price",claim:"4.83",
      variables:{units:{value:3,source:"3"},price:{value:1.61,source:"$1.61"}}}),
      "I sold 3 drinks at $1.61 each.",[],"en");
    expect(result).toEqual({ok:true,value:4.83});
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
  it("does NOT scale a plain scalar multiplied by a percent (counting rate-units, not a dimension change)",()=>{
    const result=verifyFormulaEntry(entry({formula:"count * rate",claim:"30%",
      variables:{count:{value:3,source:"3"},rate:{value:10,source:"10%"}}}),
      "Apply the 10% rate 3 times.",[],"en");
    expect(result).toEqual({ok:true,value:30});
  });
});

describe("findOwnerQuotedSpan -- a hyphenated date/range is never misread as a negative number (Codex finding hardening)",()=>{
  it("still matches an unsigned day-of-month inside a plain ISO date the owner wrote verbatim",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"5",variables:{a:{value:5,source:"5"}}}),
      "We opened on 2026-10-05.",[],"en");
    expect(result).toEqual({ok:true,value:5});
  });
});

describe("verifyFormulaEntry -- computed result unit must match an explicitly-decorated claim (Codex finding #1)",()=>{
  it("rejects a scalar result (drinks-count plus shift-count) dressed up as a dollar claim",()=>{
    const result=verifyFormulaEntry(entry({formula:"drinks + shifts",claim:"$5",
      variables:{drinks:{value:3,source:"3"},shifts:{value:2,source:"2"}}}),
      "I covered 3 drinks and 2 shifts.",[],"en");
    expect(result).toEqual({ok:false,failure:{reason:"incompatible_units"}});
  });
  it("still accepts the same scalar result when the claim is left undecorated (no fabrication risk -- the number itself is still independently recomputed)",()=>{
    const result=verifyFormulaEntry(entry({formula:"drinks + shifts",claim:"5",
      variables:{drinks:{value:3,source:"3"},shifts:{value:2,source:"2"}}}),
      "I covered 3 drinks and 2 shifts.",[],"en");
    expect(result).toEqual({ok:true,value:5});
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
