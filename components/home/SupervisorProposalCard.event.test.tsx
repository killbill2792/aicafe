import {describe,expect,it} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {EventReadinessPreview,type ProposalView} from "./SupervisorProposalCard";

const saved:ProposalView={
  proposalId:"11111111-1111-4111-8111-111111111111",
  revision:1,state:"pending",capabilityId:"alex.event_readiness.v1",
  productName:"Halloween · Saturday",
  preview:[
    {label:"Preparation",before:"",after:"Check usual Saturday supplies"},
    {label:"Operations",before:"",after:"Use the regular Saturday staffing baseline"},
  ],
};

describe("historical event proposal renders as read-only advice",()=>{
  it.each(["en","es","ar"] as const)("shows suggestion icons without old approval controls in %s",locale=>{
    const html=renderToStaticMarkup(createElement(EventReadinessPreview,{value:saved,locale}));
    expect(html).toContain("Halloween · Saturday");
    expect(html).toContain("Check usual Saturday supplies");
    expect(html).toContain("Use the regular Saturday staffing baseline");
    expect(html).toContain("<ul");
    expect(html).toContain("<svg");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("Use this plan");
    expect(html).toContain('dir="'+(locale==="ar"?"rtl":"ltr")+'"');
  });
});
