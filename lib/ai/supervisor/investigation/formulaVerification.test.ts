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
      "I sold 3 drinks at $1.61 each.",[]);
    expect(result).toEqual({ok:true,value:4.83});
  });
  it("rejects a variable whose quoted source does not actually appear in the owner's message",()=>{
    const result=verifyFormulaEntry(entry({variables:{a:{value:4.83,source:"$9.99"}}}),
      "I sold 3 drinks at $1.61 each.",[]);
    expect(result).toEqual({ok:false,failure:{reason:"source_unverifiable",variable:"a"}});
  });
  it("rejects when the recomputed arithmetic does not match the paragraph's stated claim",()=>{
    const result=verifyFormulaEntry(entry({formula:"unitsSold * pricePerUnit",claim:"9.00",
      variables:{unitsSold:{value:3,source:"3"},pricePerUnit:{value:1.61,source:"$1.61"}}}),
      "I sold 3 drinks at $1.61 each.",[]);
    expect(result.ok).toBe(false);
    if(!result.ok)expect(result.failure.reason).toBe("result_mismatch");
  });
});

describe("verifyFormulaEntry -- observation-pointer sources",()=>{
  it("verifies a formula whose input resolves to a real observation's recorded field",()=>{
    const o=observation("r1","priceCents",525);
    const result=verifyFormulaEntry(entry({formula:"priceCents / 100",claim:"5.25",
      variables:{priceCents:{value:525,source:"r1:value.priceCents"}}}),"",[o]);
    expect(result).toEqual({ok:true,value:5.25});
  });
  it("rejects a pointer to an observation id that was never produced this turn",()=>{
    const result=verifyFormulaEntry(entry({variables:{a:{value:5.25,source:"r9:value.priceCents"}}}),"",[]);
    expect(result).toEqual({ok:false,failure:{reason:"source_not_found",variable:"a"}});
  });
  it("rejects a pointer into an observation that came back unavailable",()=>{
    const o=observation("r1","priceCents",525,"unavailable");
    const result=verifyFormulaEntry(entry({variables:{a:{value:5.25,source:"r1:value.priceCents"}}}),"",[o]);
    expect(result).toEqual({ok:false,failure:{reason:"source_not_found",variable:"a"}});
  });
  it("rejects a pointer to a real observation that has no such field",()=>{
    const o=observation("r1","priceCents",525);
    const result=verifyFormulaEntry(entry({variables:{a:{value:5.25,source:"r1:value.otherField"}}}),"",[o]);
    expect(result).toEqual({ok:false,failure:{reason:"source_not_found",variable:"a"}});
  });
});

describe("verifyFormulaEntry -- owner-quote matching is exact-boundary, not substring (Codex finding #3)",()=>{
  it("never lets a declared source of \"10\" match inside an owner-written \"100\"",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"10",variables:{a:{value:10,source:"10"}}}),
      "We sold 100 drinks yesterday.",[]);
    expect(result).toEqual({ok:false,failure:{reason:"source_unverifiable",variable:"a"}});
  });
  it("matches a legitimately-quoted number even when the owner's formatting differs ($1.45 owner text, 1.45 declared source)",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"1.45",variables:{a:{value:1.45,source:"1.45"}}}),
      "The special is $1.45 today.",[]);
    expect(result).toEqual({ok:true,value:1.45});
  });
  it("matches a legitimately-quoted number in the other direction (1.45 owner text, $1.45 declared source)",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"1.45",variables:{a:{value:1.45,source:"$1.45"}}}),
      "The special is 1.45 today.",[]);
    expect(result).toEqual({ok:true,value:1.45});
  });
  it("matches an Arabic-Indic numeral owner quote against an ASCII-digit declared source (Codex finding, non-ASCII numerals)",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"100",variables:{a:{value:100,source:"100"}}}),
      "بعنا ١٠٠ مشروب.",[]);
    expect(result).toEqual({ok:true,value:100});
  });
  it("still never lets a declared source of \"10\" match inside an Arabic-Indic owner-written \"١٠٠\"",()=>{
    const result=verifyFormulaEntry(entry({formula:"a",claim:"10",variables:{a:{value:10,source:"10"}}}),
      "بعنا ١٠٠ مشروب.",[]);
    expect(result).toEqual({ok:false,failure:{reason:"source_unverifiable",variable:"a"}});
  });
});

describe("verifyFormulaEntry -- unit-aware verification (Codex finding #1)",()=>{
  it("rejects adding a plain unit count to a dollar amount even when the arithmetic is numerically correct",()=>{
    const result=verifyFormulaEntry(entry({formula:"a + b",claim:"5",
      variables:{a:{value:3,source:"3"},b:{value:2,source:"$2"}}}),
      "I sold 3 drinks and spent $2 on supplies.",[]);
    expect(result).toEqual({ok:false,failure:{reason:"incompatible_units"}});
  });
  it("still accepts a scalar multiplied by a money amount (a unit price times a quantity)",()=>{
    const result=verifyFormulaEntry(entry({formula:"units * price",claim:"4.83",
      variables:{units:{value:3,source:"3"},price:{value:1.61,source:"$1.61"}}}),
      "I sold 3 drinks at $1.61 each.",[]);
    expect(result).toEqual({ok:true,value:4.83});
  });
  it("rejects adding a plain observation-pointer count to a money-pointer amount",()=>{
    const count=observation("r1","quantitySoldLast28Days",10);
    const price=observation("r2","priceCents",525);
    const result=verifyFormulaEntry(entry({formula:"a + b",claim:"535",
      variables:{a:{value:10,source:"r1:value.quantitySoldLast28Days"},
        b:{value:525,source:"r2:value.priceCents"}}}),"",[count,price]);
    expect(result).toEqual({ok:false,failure:{reason:"incompatible_units"}});
  });
});

describe("verifyFormulaEntry -- grammar failures surface as a specific reason",()=>{
  it("rejects an unsupported grammar instead of silently failing",()=>{
    const result=verifyFormulaEntry(entry({formula:"sum(a)",variables:{a:{value:1,source:"1"}}}),"I have 1 drink.",[]);
    expect(result).toEqual({ok:false,failure:{reason:"grammar",detail:"unsupported_grammar"}});
  });
  it("rejects division by zero",()=>{
    const result=verifyFormulaEntry(entry({formula:"a / b",
      variables:{a:{value:1,source:"1"},b:{value:0,source:"0"}}}),"1 over 0.",[]);
    expect(result).toEqual({ok:false,failure:{reason:"grammar",detail:"division_by_zero"}});
  });
});
