import {describe,it,expect} from "vitest";
import {partialAnswerFromEvidence} from "./partialAnswer";
describe("partial answer when research ends without text",()=>{
  it("restates retrieved rows and says what is unfinished",()=>{
    const t=partialAnswerFromEvidence([JSON.stringify({ok:true,rows:[{profit:123}]})]);
    expect(t).toContain("\"profit\":123");
    expect(t).toMatch(/not a complete answer/);
  });
  it("is empty when nothing was retrieved",()=>expect(partialAnswerFromEvidence([])).toBe(""));
  it("bounds each snippet and keeps only the latest three",()=>{
    const t=partialAnswerFromEvidence(["a","b","c".repeat(5000),"d"]);
    expect(t).not.toContain("\"a\"");
    expect(t.length).toBeLessThan(5000);
  });
});
