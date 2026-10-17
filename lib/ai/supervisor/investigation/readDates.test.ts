import {it,expect} from "vitest";
import {investigationReadDatesMatch as checkDates,rememberInvestigationReads,investigationCalendarScope} from "./readDates";
import type {InvestigationMemory} from "@/lib/ai/conversations/investigationMemory";
const matches=(input:unknown,current:string,asOf:string,state:InvestigationMemory|undefined,statements:readonly string[])=>
  checkDates(input,current,asOf,state,statements,"test-domain",()=>"test-domain");
const asOf="2026-10-19",oldWeek="2026-10-19",newWeek="2026-10-26";
const remembered=(input:object)=>({capabilityId:"registered.reader",inputJson:JSON.stringify(input)});
const memory=(input:object,statement="Review the plan"):InvestigationMemory=>({version:1,businessId:"cafe",
  ownerStatements:[statement],reads:[remembered(input)],
  calendarScopes:[investigationCalendarScope(input,"test-domain")!].filter(Boolean)});
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
  const m={...memory({week:oldWeek},"Review the week of 2026-10-19"),calendarScopes:[{domain:"test-domain",kind:"week" as const,week:newWeek}]};
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
  const m={...memory({period:a}),calendarScopes:undefined,reads:[remembered({period:a}),remembered({period:b})]};
  expect(matches({period:a},"Only actual entries",asOf,m,[...m.ownerStatements,"Only actual entries"])).toBe(true);
  expect(matches({period:b},"Only actual entries",asOf,m,[...m.ownerStatements,"Only actual entries"])).toBe(true);
  expect(matches({period:{from:"2026-10-15",to:"2026-10-19"}},"Only actual entries",asOf,m,[...m.ownerStatements,"Only actual entries"])).toBe(false);
});
it.each(["Show expenses month to date","Gastos en lo que va del mes","المصاريف منذ بداية الشهر"])("replaces a previous day with an explicit relative period: %s",text=>{
  const old={from:"2026-10-01",to:"2026-10-01"};
  const m=memory({period:old});
  expect(matches({period:{from:"2026-10-01",to:asOf}},text,asOf,m,[...m.ownerStatements,text])).toBe(true);
  expect(matches({period:old},text,asOf,m,[...m.ownerStatements,text])).toBe(false);
});
it.each(["Use today instead","Usa hoy","استخدم اليوم"])("binds relative days to the replacement scheduling week: %s",text=>{
  const m=memory({week:"2026-10-12"});
  expect(matches({request:{week:oldWeek}},text,asOf,m,[...m.ownerStatements,text])).toBe(true);
  expect(matches({request:{week:"2026-10-12"}},text,asOf,m,[...m.ownerStatements,text])).toBe(false);
});
it("retains the calendar guard when a full operation budget reads only catalogs",()=>{
  const calendar=remembered({week:oldWeek});
  const reads=rememberInvestigationReads([calendar],Array.from({length:5},(_,i)=>remembered({productId:String(i)})));
  expect(reads).toHaveLength(5);
  expect(reads).toContainEqual(calendar);
  const m={...memory({week:oldWeek}),reads};
  expect(matches({week:newWeek},"Change her hours",asOf,m,[...m.ownerStatements,"Change her hours"])).toBe(false);
});

it("prefers the latest persisted owner correction when old selectors survive a failed read",()=>{
  const m={...memory({week:oldWeek}),calendarScopes:[{domain:"test-domain",kind:"week" as const,week:newWeek}],ownerStatements:["Review the week of 2026-10-19","Use the week of 2026-10-26 instead"]};
  expect(matches({week:newWeek},"Please retry",asOf,m,[...m.ownerStatements,"Please retry"])).toBe(true);
  expect(matches({week:oldWeek},"Please retry",asOf,m,[...m.ownerStatements,"Please retry"])).toBe(false);
});

it("keeps money and labor periods separate even when the latest owner date concerns labor",()=>{
  const money={domain:"money",kind:"period" as const,from:"2026-09-01",to:"2026-09-30"};
  const labor={domain:"labor",kind:"period" as const,from:"2026-10-12",to:"2026-10-18"};
  const m={...memory({period:money}),calendarScopes:[money,labor],ownerStatements:["Expenses from 2026-09-01 to 2026-09-30","Labor from 2026-10-12 to 2026-10-18"]};
  expect(checkDates({period:{from:money.from,to:money.to}},"What did we spend?",asOf,m,[...m.ownerStatements,"What did we spend?"],"money",()=>"money")).toBe(true);
  expect(checkDates({period:{from:labor.from,to:labor.to}},"What did we spend?",asOf,m,[...m.ownerStatements,"What did we spend?"],"money",()=>"money")).toBe(false);
});
