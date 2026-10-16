import {describe,expect,it} from "vitest";
import {rebaseQuotedOccurrence} from "./quoteOccurrences";

describe("owner-quoted occurrence rebasing",()=>{
  const goal="Use 10 hours and 10 percent";
  const allClauses=["Use 10 hours","10 percent"];
  const index=(coveredClauses:string[],occurrence:number,
    quotedNumber="10",text=goal,clauses=allClauses)=>
    rebaseQuotedOccurrence({goal:text,allClauses:clauses,
      coveredClauses,quotedNumber,occurrence});
  it("rebases the second identical number from the full turn to one clause",()=>{
    expect(index([allClauses[1]],1)).toBe(0);
    expect(index([allClauses[0]],0)).toBe(0);
    expect(index(allClauses,1)).toBe(1);
  });
  it("refuses borrowing a quoted number from another audited clause",()=>{
    expect(index([allClauses[1]],0)).toBeNull();
    expect(index([allClauses[0]],1)).toBeNull();
    expect(index([allClauses[1]],2)).toBeNull();
  });
  it("recognizes Spanish and Arabic numeric quoting without partial grouping",()=>{
    const spanish="Usa 10 horas y 10 por ciento";
    const es=["Usa 10 horas","10 por ciento"];
    expect(index([es[1]],1,"10",spanish,es)).toBe(0);
    const arabic="استخدم ١٠ ساعات و ١٠ بالمائة";
    const ar=["استخدم ١٠ ساعات","١٠ بالمائة"];
    expect(index([ar[1]],1,"١٠",arabic,ar)).toBe(0);
    const grouped="Sell 1,000 items and 10 items";
    const groups=["Sell 1,000 items","10 items"];
    expect(index([groups[1]],0,"10",grouped,groups)).toBe(0);
    expect(index([groups[0]],0,"10",grouped,groups)).toBeNull();
  });
  it("refuses malformed, unknown, reversed or ambiguous audit intervals",()=>{
    expect(index(["missing goal"],1)).toBeNull();
    expect(index([allClauses[1]],-1)).toBeNull();
    expect(index([allClauses[1]],31)).toBeNull();
    expect(index([allClauses[1]],0,"1")).toBeNull();
    expect(index([allClauses[1]],1,"10",goal,[allClauses[1],allClauses[0]]))
      .toBeNull();
  });
});
