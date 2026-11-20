import {describe,expect,it} from "vitest";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {SupervisorReplyBlock,EvidenceReference} from "@/lib/ai/conversations/contracts";
import {groupReplyBlocks,joinedAgentTextSpans,originalReplyBlockIndex,sourceLabel,uniqueSources} from "./supervisorReplyPresentation";
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
  it("formats metrics in the authenticated café currency without sign-based success or progress",()=>{
    const html=renderToStaticMarkup(React.createElement(FactSummary,{blocks:[facts[0]] as Extract<SupervisorReplyBlock,{type:"metric"}>[],locale:"en",sourceText:"Source",cafeCurrency:"EUR"}));
    expect(html).toContain("€5,000.00");expect(html).not.toContain("text-good");expect(html).not.toContain("text-warn");
    const missing=renderToStaticMarkup(React.createElement(FactSummary,{blocks:[facts[0]] as Extract<SupervisorReplyBlock,{type:"metric"}>[],locale:"en",sourceText:"Source",cafeCurrency:null}));
    expect(missing).toContain("Café currency could not be verified.");expect(missing).not.toContain("$5,000");
  });
  it("localizes ALL evidence-source enums in English, Spanish and Arabic",()=>{
    const codes:EvidenceReference["source"][]=["cafe_state","historical_rollups","staff_timecards",
      "pricing_engine","operating_tasks","owner_rules","verified_external","unverified_external"];
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

describe("persisted provenance block index mapping",()=>{
  it("matches original text block after grouped fact cards",()=>{
    const before={type:"text",text:"Earlier message"};
    const after={type:"text",text:"Payroll is recorded for 90 days."};
    const blocks=[before,...facts,after];
    const groups=groupReplyBlocks(blocks);
    expect(groups).toHaveLength(3);
    expect(groups[1].kind).toBe("facts");
    expect(groups[2].kind).toBe("single");
    if(groups[2].kind!=="single")throw Error("expected text");
    expect(originalReplyBlockIndex(blocks,groups[2].block)).toBe(5);
    expect(originalReplyBlockIndex(blocks,{})).toBe(-1);
  });
});

describe("agent Markdown storage boundaries",()=>{
 it("joins exact text and rebases source offsets across chunks, not across approvals",()=>{
   const head={type:"text",text:"## Sales\nItem | Revenue\n--- | ---:\nLatte | $50\n"};
   const tail={type:"text",text:"Mocha | $60\n"};
   const card={type:"proposal_card",proposalId:"33333333-3333-4333-8333-333333333333"};
   const after={type:"text",text:"End."};
   const groups=groupReplyBlocks([head,tail,card,after],true);
   expect(groups).toHaveLength(3);
   const first=groups[0];
   if(first.kind!=="agentText")throw Error("expected joined text");
   expect(first.text).toBe(head.text+tail.text);
   const start=tail.text.indexOf("$60");
   expect(joinedAgentTextSpans(first,[{blockIndex:1,start,end:start+3,source:"estimate"},
     {blockIndex:3,start:0,end:3,source:"owner"},{blockIndex:1,start:0,end:999}]))
     .toEqual([{start:head.text.length+start,end:head.text.length+start+3,source:"estimate",detail:undefined}]);
   expect(groups[1]).toEqual({kind:"single",block:card});
   expect(groupReplyBlocks([head,tail])).toEqual([{kind:"single",block:head},{kind:"single",block:tail}]);
 });
});
