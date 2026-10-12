import {describe,expect,it} from "vitest";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {SupervisorReplyBlock,EvidenceReference} from "@/lib/ai/conversations/contracts";
import {groupReplyBlocks,sourceLabel,uniqueSources} from "./supervisorReplyPresentation";
import FactSummary from "./FactSummary";
const source=(kind:EvidenceReference["source"]):EvidenceReference=>({
  source:kind,identifier:"test",asOf:"2026-10-12",
});
const facts:SupervisorReplyBlock[]=[
  {type:"metric",label:"Total business costs — month to date",valueCents:500000,source:source("cafe_state")},
  {type:"metric",label:"Staff cost — month to date",valueCents:372172,source:source("staff_timecards")},
  {type:"count",label:"Products on your menu",value:14,source:source("cafe_state")},
  {type:"count",label:"Verified price changes",value:0,source:source("pricing_engine")},
];
describe("Supervisor fact presentation",()=>{
  it("groups consecutive facts into one multi-fact 2-column desktop layout, without repeat source footers",()=>{
    const groups=groupReplyBlocks([...facts,{type:"text",text:"Prices need more data."}]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({kind:"facts",blocks:facts});
    const html=renderToStaticMarkup(React.createElement(FactSummary,{
      blocks:facts as Extract<SupervisorReplyBlock,{type:"metric"|"count"}>[],
      locale:"en",sourceText:"Source",
    }));
    expect(html).toContain('data-testid="supervisor-fact-grid"');
    expect(html).toContain("sm:grid-cols-2");
    expect(html).toContain("Staff records");
    expect(html).not.toContain("Verified source");
    expect(html).toContain("14");
    expect(html).toContain("Total business costs — month to date");
    expect(uniqueSources(facts as Extract<SupervisorReplyBlock,{type:"metric"|"count"}>[])).toHaveLength(3);
  });
  it("keeps a single fact compact",()=>{
    const groups=groupReplyBlocks([facts[0]]);
    expect(groups).toMatchObject([{kind:"facts",blocks:[facts[0]]}]);
    const html=renderToStaticMarkup(React.createElement(FactSummary,{
      blocks:[facts[0]] as Extract<SupervisorReplyBlock,{type:"metric"|"count"}>[],
      locale:"en",sourceText:"Source",
    }));
    expect(html).toContain('data-testid="supervisor-fact-single"');
    expect(html).not.toContain("sm:grid-cols-2");
  });
  it("localizes ALL evidence-source enums in English, Spanish and Arabic",()=>{
    const codes:EvidenceReference["source"][]=["cafe_state","historical_rollups","staff_timecards",
      "pricing_engine","operating_tasks","owner_rules","verified_external"];
    for(const locale of ["en","es","ar"] as const)for(const code of codes){
      const label=sourceLabel(code,locale);
      expect(label.length).toBeGreaterThan(3);
      expect(label).not.toBe(code);
      expect(label).not.toBe("Verified source");
    }
    expect(sourceLabel("staff_timecards","en")).toBe("Staff records");
    expect(sourceLabel("staff_timecards","es")).toBe("Registros del personal");
    expect(sourceLabel("staff_timecards","ar")).toBe("سجلات الموظفين");
  });
});
