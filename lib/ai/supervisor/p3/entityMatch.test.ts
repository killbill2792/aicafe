import {describe,expect,it} from "vitest";
import {isWholeNamedEntity} from "./entityMatch";
describe("P3 authenticated entity mention matching",()=>{
  it("rejects shorter names buried inside common words",()=>{
    expect(isWholeNamedEntity("Please calculate labor costs","Al",[
      {id:"al",name:"Al"}])).toBe(false);
    expect(isWholeNamedEntity("How many minutes for Al?","Al",[
      {id:"al",name:"Al"}])).toBe(true);
  });
  it("prefers a longer actual catalog product over an overlapping short name",()=>{
    const candidates=[{id:"oat",name:"oat"},{id:"oat-milk",name:"oat milk"}];
    expect(isWholeNamedEntity("Compare oat milk costs","oat",candidates))
      .toBe(false);
    expect(isWholeNamedEntity("Compare oat milk costs","oat milk",candidates))
      .toBe(true);
    expect(isWholeNamedEntity("What does oat cost?","oat",candidates))
      .toBe(true);
  });
  it("fails closed on duplicate names and supports Unicode owner wording",()=>{
    const duplicate=[{id:"a",name:"Sophie"},{id:"b",name:"Sophie"}];
    expect(isWholeNamedEntity("Sophie works today","Sophie",duplicate)).toBe(false);
    expect(isWholeNamedEntity("قارن حليب الشوفان","حليب الشوفان",[
      {id:"milk",name:"حليب الشوفان"}])).toBe(true);
  });
});
