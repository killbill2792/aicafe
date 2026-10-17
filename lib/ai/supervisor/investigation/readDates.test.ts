import {it,expect} from "vitest";
import {investigationReadDatesMatch as matches,rememberInvestigationReads} from "./readDates";
import type {InvestigationMemory} from "@/lib/ai/conversations/investigationMemory";
const asOf="2026-10-19",oldWeek="2026-10-19",newWeek="2026-10-26";
const remembered=(input:object)=>({capabilityId:"registered.reader",inputJson:JSON.stringify(input)});
const memory=(input:object,statement="Review the plan"):InvestigationMemory=>({version:1,businessId:"cafe",
  ownerStatements:[statement],reads:[remembered(input)]});
it("binds nested week selectors across reader changes without freezing non-temporal reads",()=>{
  const m=memory({week:oldWeek});
  expect(matches({request:{week:newWeek}},"Change her hours",asOf,m,[...m.ownerStatements,"Change her hours"])).toBe(false);
  expect(matches({request:{week:oldWeek}},"Change her hours",asOf,m,[...m.ownerStatements,"Change her hours"])).toBe(true);
  expect(matches({productId:"latte"},"Change her hours",asOf,m,[...m.ownerStatements,"Change her hours"])).toBe(true);
});
it.each(["Use next week instead","Usa la próxima semana","استخدم الأسبوع القادم"])("allows explicit calendar replacement: %s",text=>{
  const m=memory({week:oldWeek});
  expect(matches({week:newWeek},text,asOf,m,[...m.ownerStatements,text])).toBe(true);
  expect(matches({week:oldWeek},text,asOf,m,[...m.ownerStatements,text])).toBe(false);
});
it("does not lose a failed owner's newer explicit date when resuming a turn",()=>{
  const m=memory({week:oldWeek},"Review the week of 2026-10-19");
  const statements=[...m.ownerStatements,"Use the week of 2026-10-26 instead","Continue"];
  expect(matches({week:newWeek},"Continue",asOf,m,statements)).toBe(true);
  expect(matches({week:oldWeek},"Continue",asOf,m,statements)).toBe(false);
});
it("retains the period through intervening catalog reads and expires replaced periods",()=>{
  const first=remembered({period:{from:"2026-10-01",to:"2026-10-07"}});
  const catalog=remembered({productId:"latte"});
  const middle=rememberInvestigationReads([first],[catalog]);
  expect(middle).toContainEqual(first);
  const replacement=remembered({period:{from:"2026-10-08",to:"2026-10-14"}});
  const next=rememberInvestigationReads(middle,[replacement]);
  expect(next).not.toContainEqual(first);
  expect(next).toContainEqual(replacement);
  expect(next).toContainEqual(catalog);
});
it("preserves each validated comparison period without admitting a new one",()=>{
  const a={from:"2026-10-01",to:"2026-10-07"},b={from:"2026-10-08",to:"2026-10-14"};
  const m={...memory({period:a}),reads:[remembered({period:a}),remembered({period:b})]};
  expect(matches({period:a},"Only actual entries",asOf,m,[...m.ownerStatements,"Only actual entries"])).toBe(true);
  expect(matches({period:b},"Only actual entries",asOf,m,[...m.ownerStatements,"Only actual entries"])).toBe(true);
  expect(matches({period:{from:"2026-10-15",to:"2026-10-19"}},"Only actual entries",asOf,m,[...m.ownerStatements,"Only actual entries"])).toBe(false);
});
