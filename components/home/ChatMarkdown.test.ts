import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown, SourceLegend,ProvenanceTooltip,provenanceScrollCommand,sourceDotIsOpen,sourceDotNext } from "./ChatMarkdown";

describe("chat message rendering", () => {
  it("renders bold, ordered/unordered lists and inline code without raw markers", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "**Profit**\n\n- Costs\n- Sales\n\n1. First\n2. Second\n\nUse `menu`",
      label: "Unverified",
    }));
    expect(html).toContain("<strong");
    expect(html).toContain("<ul");
    expect(html).toContain("<ol");
    expect(html).toContain("<code");
    expect(html).not.toContain("**Profit**");
  });
  it("preserves explicit ordered steps across blank lines and non-one starts", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "3. Check sales\n\n4. Check costs\n\n5. Review **profit**",
      label: "Unverified",
    }));
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html).toContain('start="3"');
    expect(html).toContain('value="3"');
    expect(html).toContain('value="4"');
    expect(html).toContain('value="5"');
    expect(html).toContain("<strong");
  });
  it("keeps markdown lists and formatting when a number is unverified", () => {
    const source = "1. **Revenue $123**\n\n2. Check costs";
    const start = source.indexOf("$123");
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: source, unverified: [{ start, end: start + 4 }], label: "Unverified",
    }));
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html).toContain("<strong");
    expect(html).toContain('value="2"');
    expect(html).toContain("Unverified");
    expect(html).not.toContain("**");
  });
  it("supports CRLF offsets, literal HTML and multiple independent labels", () => {
    const source = "1. **$10**\r\n2. _€20_";
    const startA = source.indexOf("$10"), startB = source.indexOf("€20");
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: source, unverified: [
        { start: startA, end: startA + 3 }, { start: startB, end: startB + 3 },
      ], label: "Unverified",
    }));
    expect(html.match(/aria-label="Unverified"/g)).toHaveLength(2);
    expect(html).toContain("<strong");
    expect(html).toContain("<em");
    expect(html.match(/<ol/g)).toHaveLength(1);
  });
  it("escapes model HTML rather than injecting it", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "<script>alert('bad')</script>", label: "Unverified",
    }));
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("preserves original source offsets and labels unverified figures", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "Total **$123**", unverified: [{ start: 8, end: 14 }], label: "Unverified",
    }));
    expect(html).toContain("Unverified");
    expect(html).toContain("$123");
  });
});

describe("provenance footnotes",()=>{
 const labels={owner:"You told me",estimate:"Estimate",unchecked:"Not checked against your records"};
 it("shows an accessible blue superscript immediately after complete currency value",()=>{
   const text="$11,000 in sales";
   const html=renderToStaticMarkup(createElement(ChatMarkdown,{text,labels,unverified:[
     {start:0,end:7,source:"owner"}]}));
   expect(html).toContain('aria-label="You told me"');
   expect(html).toContain('aria-expanded="false"');
   expect(html).toContain("bg-chart-staff");
   expect(html).toContain("$11,000");
   expect(html).not.toContain("Not checked against your records");
 });
 it("renders a single tiny legend with only colors actually in the answer",()=>{
   const text="$884 versus $11,000";
   const html=renderToStaticMarkup(createElement(ChatMarkdown,{text,labels,unverified:[
     {start:0,end:4,source:"estimate",detail:"Ingredient percentage"},
     {start:12,end:19,source:"owner"}]}));
   expect(html).toContain("Ingredient percentage");
   expect(html).toContain("bg-warn");
   expect(html).toContain("bg-chart-staff");
   expect(html).not.toContain("border border-ink bg-transparent");
   expect(html.match(/aria-label="Number sources"/g)).toHaveLength(1);
 });
 it("has no legend for dates and unlabeled day counts",()=>{
   const html=renderToStaticMarkup(createElement(ChatMarkdown,{text:"Oct 1-22, 8 days",labels}));
   expect(html).not.toContain("Number sources");
 });
 it("attaches a six-pixel superscript directly after the number with an above-dot tooltip",()=>{
   const html=renderToStaticMarkup(createElement(ChatMarkdown,{text:"$11,000",labels,
     unverified:[{start:0,end:7,source:"owner"}]}));
   expect(html).toMatch(/\$11,000<span class="relative inline-block h-\[6px\] w-\[6px\] align-super"/);
   expect(html).toContain("h-[6px]");
   expect(html).toContain("w-[6px]");
   // Portal only appears for an active interaction; no clipped inline tooltip.
   expect(html).not.toContain("bottom-[28px]");
   expect(html).toContain("aria-expanded=\"false\"");
   expect(html).not.toContain("group-hover:block");
   expect(html).not.toContain("group-focus-visible:block");
   expect(html).toContain("h-12 w-12");
   expect(html).toContain("left-1/2 top-1/2");
   expect(html).toContain("aria-expanded=\"false\"");
   expect(html).not.toContain("margin-inline-start");
 });
 it("does not decorate calendar durations",()=>{
   const text="Payroll is recorded for 90 days.";
   const start=text.indexOf("90");
   const html=renderToStaticMarkup(createElement(ChatMarkdown,{text,labels,
     unverified:[{start,end:start+"90 days".length,source:"unchecked"}]}));
   expect(html).not.toContain('aria-label="Not checked against your records"');
   expect(html).not.toContain('role="note"');
 });
 it("keeps attached RTL marks after Arabic units and labels the tooltip accessibly",()=>{
   const text="الرواتب مسجلة لمدة ٩٠ أيام.";
   const start=text.indexOf("٩٠");
   const html=renderToStaticMarkup(createElement(ChatMarkdown,{text,labels,
     unverified:[{start,end:start+"٩٠ أيام".length,source:"unchecked"}]}));
   expect(html).toContain("٩٠ أيام");
   expect(html).not.toContain('aria-label="Not checked against your records"');
 });
});

describe("reply-wide provenance legend",()=>{
 const labels={owner:"You told me",estimate:"Estimate",unchecked:"Not checked against your records"};
 it("shows exactly one localized legend when a reply spans multiple blocks",()=>{
   const html=renderToStaticMarkup(createElement("div",null,
     createElement(ChatMarkdown,{text:"Sales $11,000",labels,showLegend:false,
       unverified:[{start:6,end:13,source:"owner"}]}),
     createElement(ChatMarkdown,{text:"Break-even $884",labels,showLegend:false,
       unverified:[{start:11,end:15,source:"estimate"}]}),
     createElement(SourceLegend,{sources:["owner","estimate"],labels,legendLabel:"Fuentes de los números"})
   ));
   expect(html.match(/aria-label="Fuentes de los números"/g)).toHaveLength(1);
   expect(html).not.toContain("border border-ink bg-transparent");
   expect(html).toContain("bg-chart-staff");
   expect(html).toContain("bg-warn");
 });
 it("omits legend completely if no spans are displayed",()=>{
   const html=renderToStaticMarkup(createElement(SourceLegend,{
     sources:[],labels,legendLabel:"مصادر الأرقام",
   }));
   expect(html).toBe("");
 });
});

describe("provenance dot pointer/keyboard/tap state",()=>{
  const initial={hovered:false,focused:false,pinned:false,dismissed:false};
  it("first tap opens even when focus fires first; second tap closes",()=>{
    let state=sourceDotNext(initial,"focus-start");
    expect(sourceDotIsOpen(state)).toBe(true);
    state=sourceDotNext(state,"click");
    expect(sourceDotIsOpen(state)).toBe(true);
    state=sourceDotNext(state,"click");
    expect(sourceDotIsOpen(state)).toBe(false);
    state=sourceDotNext(state,"focus-end");
    expect(sourceDotIsOpen(state)).toBe(false);
  });
  it("hover then click pins instead of immediately hiding the tooltip",()=>{
    let state=sourceDotNext(initial,"hover-start");
    expect(sourceDotIsOpen(state)).toBe(true);
    state=sourceDotNext(state,"click");
    expect(sourceDotIsOpen(state)).toBe(true);
    state=sourceDotNext(state,"hover-end");
    expect(sourceDotIsOpen(state)).toBe(true);
    state=sourceDotNext(state,"escape");
    expect(sourceDotIsOpen(state)).toBe(false);
  });
  it("preserves keyboard focus hint and resets after blur",()=>{
    let state=sourceDotNext(initial,"focus-start");
    expect(sourceDotIsOpen(state)).toBe(true);
    state=sourceDotNext(state,"escape");
    expect(sourceDotIsOpen(state)).toBe(false);
    state=sourceDotNext(state,"focus-end");
    state=sourceDotNext(state,"focus-start");
    expect(sourceDotIsOpen(state)).toBe(true);
  });
});

describe("readable provenance in both appearance modes",()=>{
  it("pairs theme ink and paper, with 17px warning text and viewport-bounded placement",()=>{
    const html=renderToStaticMarkup(createElement(ProvenanceTooltip,{
      label:"Estimate: daily overhead includes assumed staff tax",
      position:{left:150,top:10,width:300},
    }));
    expect(html).toContain("bg-ink");
    expect(html).toContain("text-paper");
    expect(html).toContain("text-[17px]");
    expect(html).toContain("leading-relaxed");
    expect(html).toContain("max-h-[calc(100dvh-16px)]");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("pointer-events-auto");
    expect(html).not.toContain("pointer-events-none");
    expect(html).toContain('role="tooltip"');
    expect(html).toContain("Estimate: daily overhead includes assumed staff tax");
    expect(html).not.toContain("text-white");
    expect(html).not.toContain("text-xs");
  });
  it("uses readable text for the legend rather than shrinking essential caveats",()=>{
    const html=renderToStaticMarkup(createElement(SourceLegend,{
      sources:["owner","estimate","unchecked"],
      labels:{owner:"You told me",estimate:"Estimate",unchecked:"Not checked against your records"},
    }));
    expect(html).toContain("text-[14px]");
    expect(html).toContain("leading-relaxed");
    expect(html).not.toContain("text-xs");
  });
});

describe("keyboard access to long provenance explanations",()=>{
  const initial={hovered:false,focused:false,pinned:false,dismissed:false};
  it("retains the popup while focus moves from button into its scroll surface",()=>{
    let state=sourceDotNext(initial,"focus-start");
    state=sourceDotNext(state,"click");
    state=sourceDotNext(state,"tooltip-focus-start");
    expect(sourceDotIsOpen(state)).toBe(true);
    expect(state.focused).toBe(false);
    expect(state.tooltipFocused).toBe(true);
    state=sourceDotNext(state,"tooltip-focus-end");
    expect(sourceDotIsOpen(state)).toBe(false);
  });
  it("Escape keeps the explanation closed even while returning focus to its trigger",()=>{
    let state=sourceDotNext(initial,"focus-start");
    state=sourceDotNext(state,"tooltip-focus-start");
    state=sourceDotNext(state,"focus-start");
    state=sourceDotNext(state,"tooltip-focus-end");
    state=sourceDotNext(state,"escape");
    expect(sourceDotIsOpen(state)).toBe(false);
  });
  it("offers arrow, page and edge scrolling from the focused dot",()=>{
    expect(provenanceScrollCommand("ArrowDown",200)).toBe(40);
    expect(provenanceScrollCommand("ArrowUp",200)).toBe(-40);
    expect(provenanceScrollCommand("PageDown",200)).toBe(168);
    expect(provenanceScrollCommand("PageUp",200)).toBe(-168);
    expect(provenanceScrollCommand("Home",200)).toBe("start");
    expect(provenanceScrollCommand("End",200)).toBe("end");
    expect(provenanceScrollCommand("Enter",200)).toBeNull();
  });
  it("makes long explanation scroll container keyboard-focusable",()=>{
    const html=renderToStaticMarkup(createElement(ProvenanceTooltip,{
      label:"Daily overhead includes estimated labor taxes",
      position:{left:200,top:8,width:300},
    }));
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("overflow-y-auto");
  });
});
