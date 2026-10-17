import { describe, expect, it } from "vitest";
import { alignGoalsToOwnerDates, ownerDateWindowsFromContext, parseOwnerDateWindows } from "./ownerDateIntent";
import { coversRequestedGoal, reconcileRequestScopes, type RequestedGoal } from "./requestScope";

const asOf="2026-10-16";
const goal=(domain:RequestedGoal["domain"]):RequestedGoal=>({
  domain,period:"month_to_date",from:null,to:null,
  comparison_period:null,comparison_from:null,comparison_to:null,
});

describe("Owner-written café-local dates are independent of model-selected tools",()=>{
  it("preserves two individual month-name dates rather than counting intervening days",()=>{
    const text="What's my profit margin for that August 22 and September 4?";
    const windows=parseOwnerDateWindows(text,asOf);
    expect(windows).toEqual([{from:"2026-08-22",to:"2026-08-22"},
      {from:"2026-09-04",to:"2026-09-04"}]);
    const two=alignGoalsToOwnerDates([goal("profit_margin")],text,asOf);
    expect(two).toHaveLength(2);
    expect(two.map(g=>[g.from,g.to])).toEqual([["2026-08-22","2026-08-22"],
      ["2026-09-04","2026-09-04"]]);
    expect(coversRequestedGoal(two[0],{name:"get_financials",arguments:{
      metric:"profit_margin",period:"custom",from:"2026-08-22",to:"2026-08-22",
    }})).toBe(true);
    expect(coversRequestedGoal(two[1],{name:"get_financials",arguments:{
      metric:"profit_margin",period:"custom",from:"2026-08-22",to:"2026-08-22",
    }})).toBe(false);
  });
  it("accepts model and audit with semantically different date forms",()=>{
    const text="What was my margin on August 22 and September 4?";
    const planner=alignGoalsToOwnerDates([goal("profit_margin")],text,asOf);
    const audit=alignGoalsToOwnerDates([{...goal("profit_margin"),
      period:"custom",from:"2026-08-22",to:"2026-09-04"}],text,asOf);
    expect(reconcileRequestScopes(planner,audit,true,false)).toEqual(planner);
  });
  it("respects an actual contiguous period, single day, and ISO dates",()=>{
    expect(parseOwnerDateWindows("between August 22 and September 4",asOf))
      .toEqual([{from:"2026-08-22",to:"2026-09-04"}]);
    expect(parseOwnerDateWindows("from 2026-08-22 to 2026-09-04",asOf))
      .toEqual([{from:"2026-08-22",to:"2026-09-04"}]);
    expect(parseOwnerDateWindows("margin on September 4",asOf))
      .toEqual([{from:"2026-09-04",to:"2026-09-04"}]);
  });
  it("resolves last Friday and the first week of a named month",()=>{
    expect(parseOwnerDateWindows("margin last Friday",asOf))
      .toEqual([{from:"2026-10-09",to:"2026-10-09"}]);
    expect(parseOwnerDateWindows("first week of September",asOf))
      .toEqual([{from:"2026-09-01",to:"2026-09-07"}]);
  });
  it("supports Spanish month/day phrasing as well as reversed order",()=>{
    expect(parseOwnerDateWindows("22 de agosto y 4 de septiembre",asOf))
      .toEqual([{from:"2026-08-22",to:"2026-08-22"},
        {from:"2026-09-04",to:"2026-09-04"}]);
    expect(parseOwnerDateWindows("Agosto 22 y Septiembre 4",asOf)).toHaveLength(2);
  });
  it("does not infer an unspecified future year or accept invalid dates",()=>{
    expect(parseOwnerDateWindows("November 5",asOf)).toEqual([]);
    expect(parseOwnerDateWindows("February 30",asOf)).toEqual([]);
    expect(parseOwnerDateWindows("February 28, 2025",asOf))
      .toEqual([{from:"2025-02-28",to:"2025-02-28"}]);
  });
  it("resolves a comparison follow-up from prior owner dates but not generated facts",()=>{
    const history=[
      {role:"owner",text:"How did we do on August 22 and September 4?"},
      {role:"supervisor",text:"Those two days have recorded results."},
    ];
    const question="Compare how much money I kept on those two days.";
    expect(ownerDateWindowsFromContext(question,asOf,history)).toHaveLength(2);
    const comparison=alignGoalsToOwnerDates([goal("comparison")],question,asOf,history)[0];
    expect(comparison).toMatchObject({
      period:"custom",from:"2026-09-04",to:"2026-09-04",
      comparison_period:"custom",comparison_from:"2026-08-22",comparison_to:"2026-08-22",
    });
    expect(ownerDateWindowsFromContext("What about my team?",asOf,history)).toEqual([]);
    expect(ownerDateWindowsFromContext(question,asOf,
      [{role:"supervisor",text:"August 22 and September 4"}])).toEqual([]);
  });
  it("preserves unrelated snapshot and mixed-domain goals",()=>{
    const goals=alignGoalsToOwnerDates([goal("profit_margin"),goal("team")],
      "Check profit margin on August 22 and September 4 and my Team inbox",asOf);
    expect(goals).toHaveLength(3);
    expect(goals.filter(g=>g.domain==="team")).toHaveLength(1);
  });
});
