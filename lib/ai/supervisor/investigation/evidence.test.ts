import {describe,it,expect} from "vitest";
import {observationDisplay,renderInvestigationAnswer,renderUnverifiedAnswer,citationCautionWarnings,
  buildClaimFeedback,buildUnresolvedNote,investigationReply,type Observation} from "./evidence";
import type {InvestigationAnswer} from "./protocol";

const ref=(id:string)=>({source:"cafe_state" as const,identifier:id,asOf:"2026-10-18"});
function observation(id:string,path:string,raw:number,extra:Partial<Observation["result"]>={}):Observation{
  const result={id:"test.read",value:{[path]:raw},...extra};
  const rendered=observationDisplay(result,"en");
  return {id,capabilityId:"p3.test.read.v1",input:{},result,reference:ref(id),
    display:rendered.display,displayKind:rendered.kind,displayRaw:rendered.raw};
}
const answer=(paragraphs:InvestigationAnswer["paragraphs"]):InvestigationAnswer=>({paragraphs});

describe("observationDisplay",()=>{
  it("classifies a *Cents field as money with the exact raw cents value",()=>{
    const {kind,raw}=observationDisplay({id:"x",value:{priceCents:525}},"en");
    expect(kind["value.priceCents"]).toBe("money");
    expect(raw["value.priceCents"]).toBe(525);
  });
  it("classifies a *BasisPoints field as a percent with the exact raw bps value",()=>{
    const {kind,raw}=observationDisplay({id:"x",value:{rateBasisPoints:1200}},"en");
    expect(kind["value.rateBasisPoints"]).toBe("percent");
    expect(raw["value.rateBasisPoints"]).toBe(1200);
  });
  it("never classifies an ordinary plain number as money or percent",()=>{
    const {kind}=observationDisplay({id:"x",value:{quantitySoldLast28Days:10}},"en");
    expect(kind["value.quantitySoldLast28Days"]).toBeUndefined();
  });
});

describe("renderInvestigationAnswer boxed facts",()=>{
  it("adds a metric block alongside the sentence for a cited money value",()=>{
    const o=observation("r1","priceCents",525);
    const rendered=renderInvestigationAnswer(answer([
      {kind:"evidence",text:"The recorded price is {{r1:value.priceCents}}.",citations:["r1"]},
    ]),[o],"en");
    expect(rendered).not.toBeNull();
    expect(rendered!.blocks).toContainEqual({type:"text",text:"The recorded price is $5.25."});
    expect(rendered!.blocks).toContainEqual(
      {type:"metric",label:"Amount",valueCents:525,source:ref("r1")});
  });
  it("adds a percent block alongside the sentence for a cited basis-point value",()=>{
    const o=observation("r1","rateBasisPoints",1200);
    const rendered=renderInvestigationAnswer(answer([
      {kind:"evidence",text:"The payroll burden rate is {{r1:value.rateBasisPoints}}.",citations:["r1"]},
    ]),[o],"en");
    expect(rendered!.blocks).toContainEqual(
      {type:"percent",label:"Percentage",valueBps:1200,source:ref("r1")});
  });
  it("never boxes a number from an advice or clarification paragraph",()=>{
    const rendered=renderInvestigationAnswer(answer([
      {kind:"advice",text:"Consider reviewing your pricing periodically.",citations:[]},
    ]),[],"en");
    expect(rendered!.blocks).toEqual([{type:"text",text:"Consider reviewing your pricing periodically."}]);
  });
  it("deduplicates the same observation/path cited by more than one paragraph",()=>{
    const o=observation("r1","priceCents",525);
    const rendered=renderInvestigationAnswer(answer([
      {kind:"evidence",text:"The price is {{r1:value.priceCents}}.",citations:["r1"]},
      {kind:"evidence",text:"Confirmed: {{r1:value.priceCents}} again.",citations:["r1"]},
    ]),[o],"en");
    const boxes=rendered!.blocks.filter(b=>b.type==="metric"||b.type==="percent");
    expect(boxes).toHaveLength(1);
  });
  it("places each boxed fact immediately after its own paragraph, not batched at the end",()=>{
    const revenue=observation("r1","priceCents",700);
    const cost=observation("r2","priceCents",300);
    const rendered=renderInvestigationAnswer(answer([
      {kind:"evidence",text:"Revenue is {{r1:value.priceCents}}.",citations:["r1"]},
      {kind:"evidence",text:"Cost is {{r2:value.priceCents}}.",citations:["r2"]},
    ]),[revenue,cost],"en");
    expect(rendered!.blocks).toEqual([
      {type:"text",text:"Revenue is $7.00."},
      {type:"metric",label:"Amount",valueCents:700,source:ref("r1")},
      {type:"text",text:"Cost is $3.00."},
      {type:"metric",label:"Amount",valueCents:300,source:ref("r2")},
    ]);
  });
  it("caps boxed facts at four even with five distinct money citations",()=>{
    const observations=[1,2,3,4,5].map(n=>observation("r"+n,"priceCents",n*100));
    const paragraphs=observations.map(o=>(
      {kind:"evidence" as const,text:"Price {{"+o.id+":value.priceCents}}.",citations:[o.id]}));
    const rendered=renderInvestigationAnswer(answer(paragraphs),observations,"en");
    const boxes=rendered!.blocks.filter(b=>b.type==="metric"||b.type==="percent");
    expect(boxes).toHaveLength(4);
  });
});

describe("renderUnverifiedAnswer (last-resort text for a mechanically-rejected but genuinely cited answer)",()=>{
  it("never rescues an evidence answer that also wrote a stray raw number outside any placeholder",()=>{
    // The independent review the caller runs on this text is semantic, not
    // a deterministic guarantee that a literal number traces to real data --
    // a model-typed "2" (or a fabricated "$999") could read as perfectly
    // plausible to that reviewer while being entirely unverified. Only text
    // with zero numeric/currency/URL content left after stripping every
    // placeholder is ever eligible, exactly like the strict renderer.
    const o=observation("r1","priceCents",525);
    const rescued=renderUnverifiedAnswer(answer([
      {kind:"evidence",text:"The listed price is {{r1:value.priceCents}} for 2 drinks.",citations:["r1"]},
    ]),[o],"en");
    expect(rescued).toBeNull();
  });
  it("never rescues an advice paragraph, which carries no evidence requirement at all",()=>{
    const rescued=renderUnverifiedAnswer(answer([
      {kind:"advice",text:"I have secretly published the schedule.",citations:[]},
    ]),[],"en");
    expect(rescued).toBeNull();
  });
  it("never rescues an evidence paragraph citing an observation that does not exist",()=>{
    const rescued=renderUnverifiedAnswer(answer([
      {kind:"evidence",text:"The price is {{r9:value.priceCents}}.",citations:["r9"]},
    ]),[],"en");
    expect(rescued).toBeNull();
  });
  it("never rescues an evidence paragraph citing an unavailable observation",()=>{
    const o=observation("r1","priceCents",525,{status:"unavailable"});
    const rescued=renderUnverifiedAnswer(answer([
      {kind:"evidence",text:"The price is {{r1:value.priceCents}}.",citations:["r1"]},
    ]),[o],"en");
    expect(rescued).toBeNull();
  });
  it("never rescues a clarification paragraph, since the model's self-reported kind is not proof it is really just a question",()=>{
    const rescued=renderUnverifiedAnswer(answer([
      {kind:"clarification",text:"Which remaining option should I investigate?",citations:[]},
    ]),[],"en");
    expect(rescued).toBeNull();
  });
  it("never rescues a false claim mislabeled as a clarification, where only the kind differs from the advice case",()=>{
    const rescued=renderUnverifiedAnswer(answer([
      {kind:"clarification",text:"I have published 2 schedules.",citations:[]},
    ]),[],"en");
    expect(rescued).toBeNull();
  });
  it("never rescues an answer where only some paragraphs are cited evidence",()=>{
    const o=observation("r1","priceCents",525);
    const rescued=renderUnverifiedAnswer(answer([
      {kind:"evidence",text:"The price is {{r1:value.priceCents}}.",citations:["r1"]},
      {kind:"advice",text:"Consider reviewing pricing periodically.",citations:[]},
    ]),[o],"en");
    expect(rescued).toBeNull();
  });
  it("never rescues a token whose internal grammar doesn't match, instead of leaking it raw",()=>{
    const rescued=renderUnverifiedAnswer(answer([
      {kind:"evidence",text:"The price is {{r1:value[0].priceCents}}.",citations:["r1"]},
    ]),[observation("r1","priceCents",525)],"en");
    // A malformed token is still stripped (any double-brace span, not only
    // the valid grammar), so the owner never sees literal "{{...}}" syntax.
    expect(rescued).toEqual({text:"The price is [unchecked value].",citedIds:["r1"]});
  });
  it("rejects the whole rescue if an unbalanced brace remains after stripping",()=>{
    const o=observation("r1","priceCents",525);
    const rescued=renderUnverifiedAnswer(answer([
      {kind:"evidence",text:"The price is {{r1:value.priceCents}} and a stray } brace.",citations:["r1"]},
    ]),[o],"en");
    expect(rescued).toBeNull();
  });
});

describe("renderInvestigationAnswer -- claim-level masking (§3)",()=>{
  it("masks a single unmatched freehand number but keeps the rest of the sentence and the other paragraph",()=>{
    const o=observation("r1","priceCents",525);
    const rendered=renderInvestigationAnswer(answer([
      {kind:"evidence",text:"The recorded price is {{r1:value.priceCents}}.",citations:["r1"]},
      {kind:"advice",text:"You could also try raising it by $2 next quarter.",citations:[]},
    ]),[o],"en");
    expect(rendered).not.toBeNull();
    expect(rendered!.blocks).toContainEqual({type:"text",text:"The recorded price is $5.25."});
    expect(rendered!.blocks.some(b=>b.type==="text"&&b.text.includes("[unchecked value]"))).toBe(true);
    expect(rendered!.blocks.some(b=>b.type==="text"&&b.text.includes("$2"))).toBe(false);
    expect(rendered!.issues).toContainEqual(expect.objectContaining({kind:"unmatched_number",text:"$2"}));
  });
  it("masks a word-decorated unit span as a whole, not leaving the word dangling after the digits (Codex finding, claim spans capture written units)",()=>{
    const rendered=renderInvestigationAnswer(answer([
      {kind:"advice",text:"That change is worth about 5 dollars.",citations:[]},
    ]),[],"en");
    expect(rendered!.blocks).toEqual([{type:"text",text:"That change is worth about [unchecked value]."}]);
    expect(rendered!.issues).toContainEqual(expect.objectContaining({kind:"unmatched_number",text:"5 dollars"}));
  });
  it("keeps a freehand number that is an exact echo of the owner's own words",()=>{
    const rendered=renderInvestigationAnswer(answer([
      {kind:"advice",text:"You mentioned 3 extra shifts; that is a meaningful change.",citations:[]},
    ]),[],"en",{ownerText:"What if I added 3 extra shifts?"});
    expect(rendered!.blocks).toEqual([{type:"text",text:"You mentioned 3 extra shifts; that is a meaningful change."}]);
    expect(rendered!.issues).toEqual([]);
  });
  it("keeps a freehand number backed by a verified formula entry, tagged as a computed claim",()=>{
    const rendered=renderInvestigationAnswer(answer([
      {kind:"advice",text:"With $3 and $1.83, that comes to $4.83.",citations:[],
        formulas:[{claim:"$4.83",formula:"a + b",
          variables:[{name:"a",value:3,source:"$3"},{name:"b",value:1.83,source:"$1.83"}]}]},
    ]),[],"en",{ownerText:"Assume $3 and $1.83."});
    expect(rendered!.blocks).toEqual([{type:"text",text:"With $3 and $1.83, that comes to $4.83."}]);
    expect(rendered!.hasComputedClaim).toBe(true);
    expect(rendered!.issues).toEqual([]);
  });
  it("keeps a genuinely negative freehand result backed by a verified formula entry (Codex finding, signed claim spans)",()=>{
    const rendered=renderInvestigationAnswer(answer([
      {kind:"advice",text:"After $20 in supplies against a $15 take, that's a -$5 day.",citations:[],
        formulas:[{claim:"-$5",formula:"revenue - cost",
          variables:[{name:"revenue",value:15,source:"$15"},{name:"cost",value:20,source:"$20"}]}]},
    ]),[],"en",{ownerText:"I took in $15 but spent $20 on supplies."});
    expect(rendered!.blocks).toEqual([{type:"text",text:"After $20 in supplies against a $15 take, that's a -$5 day."}]);
    expect(rendered!.hasComputedClaim).toBe(true);
    expect(rendered!.issues).toEqual([]);
  });
  it("masks a freehand number whose declared formula fails verification, without touching the rest",()=>{
    const rendered=renderInvestigationAnswer(answer([
      {kind:"advice",text:"With $3 and $1.83, that comes to $9.00.",citations:[],
        formulas:[{claim:"$9.00",formula:"a + b",
          variables:[{name:"a",value:3,source:"$3"},{name:"b",value:1.83,source:"$1.83"}]}]},
      {kind:"advice",text:"Either way, keep tracking your weekly sales.",citations:[]},
    ]),[],"en",{ownerText:"Assume $3 and $1.83."});
    expect(rendered!.blocks).toContainEqual({type:"text",text:"Either way, keep tracking your weekly sales."});
    expect(rendered!.blocks.some(b=>b.type==="text"&&b.text.includes("[unchecked value]"))).toBe(true);
    expect(rendered!.issues).toContainEqual(expect.objectContaining({kind:"formula_failed"}));
  });
  it("finds a cheap direct match against an already-produced observation before masking",()=>{
    const o=observation("r1","priceCents",525);
    const rendered=renderInvestigationAnswer(answer([
      {kind:"advice",text:"Note the price is $5.25 on the current menu.",citations:[]},
    ]),[o],"en");
    expect(rendered!.issues).toContainEqual(expect.objectContaining({kind:"unmatched_number",
      text:"$5.25",matchedObservation:{id:"r1",path:"value.priceCents"}}));
  });
  it("never lets a freehand number pass as an owner-echo via substring containment (Codex finding, owner-echo path)",()=>{
    const rendered=renderInvestigationAnswer(answer([
      {kind:"advice",text:"You could set aside 10 for supplies.",citations:[]},
    ]),[],"en",{ownerText:"We sold 100 drinks yesterday."});
    expect(rendered!.blocks.some(b=>b.type==="text"&&b.text.includes("[unchecked value]"))).toBe(true);
    expect(rendered!.issues).toContainEqual(expect.objectContaining({kind:"unmatched_number",text:"10"}));
  });
  it("masks an unverified Arabic numeral while preserving the surrounding paragraph",()=>{
    const rendered=renderInvestigationAnswer(answer([
      {kind:"advice",text:"بعنا ١٠٠ مشروب اليوم.",citations:[]},
      {kind:"advice",text:"This second paragraph has no numbers at all.",citations:[]},
    ]),[],"ar");
    expect(rendered!.blocks).toEqual([{type:"text",text:"بعنا [قيمة غير مؤكدة] مشروب اليوم."},
      {type:"text",text:"This second paragraph has no numbers at all."}]);
    expect(rendered!.issues).toContainEqual(expect.objectContaining({kind:"unmatched_number",text:"١٠٠"}));
  });
});

describe("renderInvestigationAnswer -- unavailable-citation tolerance (§2)",()=>{
  it("renders fine when a paragraph only narrates an unavailable citation without pulling a value from it",()=>{
    const o=observation("r1","priceCents",525,{status:"unavailable"});
    const rendered=renderInvestigationAnswer(answer([
      {kind:"evidence",text:"That source is currently unavailable.",citations:["r1"]},
    ]),[o],"en");
    expect(rendered).not.toBeNull();
    expect(rendered!.blocks).toEqual([{type:"text",text:"That source is currently unavailable."}]);
    expect(rendered!.issues).toEqual([]);
  });
  it("drops only the one paragraph that tries to pull a value out of an unavailable citation",()=>{
    const unavailable=observation("r1","priceCents",525,{status:"unavailable"});
    const available=observation("r2","priceCents",300);
    const rendered=renderInvestigationAnswer(answer([
      {kind:"evidence",text:"The price is {{r1:value.priceCents}}.",citations:["r1"]},
      {kind:"evidence",text:"The cost is {{r2:value.priceCents}}.",citations:["r2"]},
    ]),[unavailable,available],"en");
    expect(rendered!.blocks).toEqual([{type:"text",text:"The cost is $3.00."},
      {type:"metric",label:"Amount",valueCents:300,source:ref("r2")}]);
    expect(rendered!.issues).toContainEqual(expect.objectContaining({kind:"dropped_paragraph",reason:"empty_citation_pull"}));
  });
  it("drops only the one paragraph citing an id that was never produced this turn, keeping the rest",()=>{
    const o=observation("r1","priceCents",525);
    const rendered=renderInvestigationAnswer(answer([
      {kind:"evidence",text:"The price is {{r9:value.priceCents}}.",citations:["r9"]},
      {kind:"evidence",text:"The cost is {{r1:value.priceCents}}.",citations:["r1"]},
    ]),[o],"en");
    expect(rendered!.blocks).toEqual([{type:"text",text:"The cost is $5.25."},
      {type:"metric",label:"Amount",valueCents:525,source:ref("r1")}]);
    expect(rendered!.issues).toContainEqual(expect.objectContaining({kind:"dropped_paragraph",
      reason:"hallucinated_citation",id:"r9"}));
  });
  it("returns null only when literally nothing in the whole answer survived",()=>{
    const rendered=renderInvestigationAnswer(answer([
      {kind:"evidence",text:"The price is {{r9:value.priceCents}}.",citations:["r9"]},
    ]),[],"en");
    expect(rendered).toBeNull();
  });
});

describe("renderInvestigationAnswer -- business-specific claims (§3 non-negotiable rule)",()=>{
  it("masks a specific claim about the owner's own business even when it is an exact echo of their words",()=>{
    const rendered=renderInvestigationAnswer(answer([
      {kind:"advice",text:"Your margin is 45% right now.",citations:[]},
    ]),[],"en",{ownerText:"Is my margin 45% right now?"});
    expect(rendered!.blocks[0]).toMatchObject({type:"text",text:"Your margin is [unchecked value] right now."});
    expect(rendered!.issues).toContainEqual(expect.objectContaining({kind:"business_claim_uncited",text:"45%"}));
  });
  it("masks a specific uncited business claim even when the model mislabels the paragraph as a clarification",()=>{
    const rendered=renderInvestigationAnswer(answer([
      {kind:"clarification",text:"Your margin looks like it's around 45%, is that right?",citations:[]},
    ]),[],"en",{ownerText:"Is my margin 45%?"});
    expect(rendered!.blocks[0]).toMatchObject({type:"text",
      text:"Your margin looks like it's around [unchecked value], is that right?"});
    expect(rendered!.issues).toContainEqual(expect.objectContaining({kind:"business_claim_uncited"}));
  });
  it("never requires a citation for general, non-owner-specific language",()=>{
    const rendered=renderInvestigationAnswer(answer([
      {kind:"advice",text:"A typical café margin runs around 60%.",citations:[]},
    ]),[],"en",{ownerText:"How does this compare to typical cafés?"});
    expect(rendered!.issues).toContainEqual(expect.objectContaining({kind:"unmatched_number"}));
  });
});

describe("buildClaimFeedback / buildUnresolvedNote (§5b/§6/§7)",()=>{
  it("names the exact paragraph and the real observation a freehand number should have cited",()=>{
    const feedback=buildClaimFeedback([{kind:"unmatched_number",paragraphIndex:0,text:"$5.25",
      matchedObservation:{id:"r1",path:"value.priceCents"}}]);
    expect(feedback).toContain("r1");
    expect(feedback).toContain("$5.25");
  });
  it("lists the real valid ids for a hallucinated citation",()=>{
    const feedback=buildClaimFeedback([{kind:"dropped_paragraph",paragraphIndex:0,
      reason:"hallucinated_citation",id:"r9",validIds:["r1","r2"]}]);
    expect(feedback).toContain("r9");
    expect(feedback).toContain("r1");
    expect(feedback).toContain("r2");
  });
  it("builds no unresolved note when nothing was masked",()=>{
    expect(buildUnresolvedNote([],"en")).toBeNull();
  });
  it("builds an owner-facing note that never repeats the unverified value itself",()=>{
    const note=buildUnresolvedNote([{kind:"unmatched_number",paragraphIndex:0,text:"$999.99",matchedObservation:null}],"en");
    expect(note).not.toBeNull();
    expect(note).not.toContain("$999.99");
    expect(note).toContain("1");
  });
});

describe("investigationReply -- cards/cautions only from citations that survived rendering (Codex finding #4)",()=>{
  it("never leaks a caution from a paragraph dropped for citing one real id alongside one hallucinated id",()=>{
    const o=observation("r1","priceCents",525,{quality:{missingInputs:[],estimatedInputs:["wage"],staleInputs:[]}});
    const result=investigationReply(answer([
      {kind:"evidence",text:"The price is {{r1:value.priceCents}} and also {{r9:value.priceCents}}.",citations:["r1","r9"]},
      {kind:"advice",text:"Keep tracking your weekly sales regardless.",citations:[]},
    ]),[o],"en");
    expect(result).not.toBeNull();
    // The whole paragraph citing r1+r9 is dropped (r9 is hallucinated) --
    // r1's own estimated-inputs caution must never survive just because r1
    // itself is real and was named in the original (pre-render) paragraph.
    expect(JSON.stringify(result!.blocks)).not.toContain("SUPERVISOR_ESTIMATED");
    expect(result!.evidence).toEqual([]);
  });
  it("still carries the caution/evidence for a citation on a paragraph that DID survive rendering",()=>{
    const o=observation("r1","priceCents",525,{quality:{missingInputs:[],estimatedInputs:["wage"],staleInputs:[]}});
    const result=investigationReply(answer([
      {kind:"evidence",text:"The price is {{r1:value.priceCents}}.",citations:["r1"]},
    ]),[o],"en");
    expect(result).not.toBeNull();
    expect(JSON.stringify(result!.blocks)).toContain("SUPERVISOR_ESTIMATED");
    expect(result!.evidence).toEqual([ref("r1")]);
  });
});

describe("citationCautionWarnings (shared between the grounded and rescued reply paths)",()=>{
  it("adds the estimated-inputs caution when any cited observation has estimated inputs",()=>{
    const o=observation("r1","priceCents",525,{quality:{missingInputs:[],estimatedInputs:["wage"],staleInputs:[]}});
    const warnings=citationCautionWarnings([o],"en");
    expect(warnings).toContainEqual(expect.objectContaining({type:"warning",code:"SUPERVISOR_ESTIMATED"}));
  });
  it("adds the monetary-unavailable caution when any cited observation is missing monetary fields",()=>{
    const o=observation("r1","priceCents",525,{quality:{missingInputs:["monetary_fields_unavailable"],estimatedInputs:[],staleInputs:[]}});
    const warnings=citationCautionWarnings([o],"en");
    expect(warnings).toContainEqual(expect.objectContaining({type:"warning",code:"SUPERVISOR_MONETARY_UNAVAILABLE"}));
  });
  it("adds no cautions for an observation with none of the flagged qualities",()=>{
    const o=observation("r1","priceCents",525);
    expect(citationCautionWarnings([o],"en")).toEqual([]);
  });
});

describe("PR127 review provenance and multilingual unit boundaries",()=>{
  it.each(["advice","clarification"] as const)("retains formula sources and cautions in %s",kind=>{
    const source=observation("r1","priceCents",1000,{quality:{estimatedInputs:["price"]}});
    source.reference={...ref("external-price"),source:"unverified_external"};
    const other=observation("r2","priceCents",500);
    const a=answer([{kind,text:"The modeled difference is $5.",citations:[],formulas:[{
      claim:"$5",formula:"a - b",variables:[{name:"a",value:10,source:"r1:value.priceCents"},{name:"b",value:5,source:"r2:value.priceCents"}]}]}]);
    const rendered=renderInvestigationAnswer(a,[source,other],"en")!;
    expect(rendered.issues).toEqual([]);
    expect(rendered.citedIds).toEqual(["r1","r2"]);
    expect(rendered.evidence).toEqual([source.reference,other.reference]);
    const reply=investigationReply(a,[source,other],"en")!;
    expect(reply.evidence).toEqual([source.reference,other.reference]);
    expect(reply.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({code:"SUPERVISOR_PUBLIC_RESEARCH"}),
      expect.objectContaining({code:"SUPERVISOR_ESTIMATED"}),
    ]));
  });
  it("does not retain sources from a discarded formula paragraph",()=>{
    const source=observation("r1","priceCents",1000);
    const a=answer([{kind:"advice",text:"The difference is $6. {{bad}}",citations:[],formulas:[{
      claim:"$6",formula:"a - b",variables:[{name:"a",value:10,source:"r1:value.priceCents"},{name:"b",value:4,source:"$4"}]}]},
      {kind:"advice",text:"Check the source.",citations:[]}]);
    const rendered=renderInvestigationAnswer(a,[source],"en",{ownerText:"Assume $4."})!;
    expect(rendered.citedIds).toEqual([]);
    expect(rendered.hasComputedClaim).toBe(false);
  });
  it.each([
    ["$5","5%"],["5%","$5"],["5 dollars","5 %"],
    ["5 دولارات","5٪"],["5٪","5 دولارات"],["$5","€5"],["5 cents","5 dollars"],
  ])("does not echo %s as %s",(ownerText,claim)=>{
    const rendered=renderInvestigationAnswer(answer([{kind:"advice",text:"Consider "+claim+".",citations:[]}]),[],"en",{ownerText})!;
    expect(rendered.issues).toHaveLength(1);
    expect(rendered.blocks[0]).not.toEqual({type:"text",text:"Consider "+claim+"."});
  });
  it.each(["5 دولارات","5 دولار","5٪","5 ٪"])("checks the complete Arabic claim %s",claim=>{
    const rendered=renderInvestigationAnswer(answer([{kind:"advice",text:"النتيجة "+claim+".",citations:[],formulas:[{
      claim,formula:"a + b",variables:[{name:"a",value:3,source:"3"},{name:"b",value:2,source:"2"}]}]}]),[],"ar",{ownerText:"3 drinks and 2 shifts"})!;
    expect(rendered.issues).toContainEqual(expect.objectContaining({kind:"formula_failed",text:claim,
      failure:{reason:"requires_registered_calculator"}}));
  });
  it.each(["$5","5 dollars","5 دولارات","5٪"])("keeps compatible complete echoes: %s",claim=>{
    const rendered=renderInvestigationAnswer(answer([{kind:"advice",text:"Consider "+claim+".",citations:[]}]),[],"en",{ownerText:claim})!;
    expect(rendered.issues).toEqual([]);
  });
});

describe("PR127 multilingual and typed-echo Codex regressions",()=>{
  it.each([
    ["en","$5","Schedule 5 employees."],
    ["en","5%","Schedule 5 employees."],
    ["es","$5","Programa 5 empleados."],
    ["ar","5٪","جدول 5 موظفين."],
  ] as const)("does not relabel %s owner's %s into a count", (locale,ownerText,text)=>{
    const rendered=renderInvestigationAnswer(answer([{kind:"advice",text,citations:[]}]),[],locale,{ownerText})!;
    expect(rendered.issues).toContainEqual(expect.objectContaining({kind:"unmatched_number"}));
  });
  it.each([
    ["es","Tu ganancia es $5.","¿Tu ganancia es $5?"],
    ["es","Nuestra venta es $5.","Nuestra venta es $5."],
    ["ar","ربحك $5.","ربحك $5."],
    ["ar","مبيعاتك 5٪.","مبيعاتك 5٪."],
  ] as const)("never licenses own-business results in %s from an owner echo", (locale,text,ownerText)=>{
    const rendered=renderInvestigationAnswer(answer([{kind:"advice",text,citations:[]}]),[],locale,{ownerText})!;
    expect(rendered.issues).toContainEqual(expect.objectContaining({kind:"business_claim_uncited"}));
  });
  it("preserves an untyped neutral repetition of the original money amount",()=>{
    const rendered=renderInvestigationAnswer(answer([{kind:"advice",text:"Consider 5.",citations:[]}]),[],"en",{ownerText:"$5"})!;
    expect(rendered.issues).toEqual([]);
  });
});

describe("PR127 second-review rendering regressions",()=>{
  it.each(["$5","5%","5 dollars","5٪","5 دولارات"])("does not echo a count as %s",claim=>{
    const rendered=renderInvestigationAnswer(answer([{kind:"advice",text:"Consider "+claim+".",citations:[]}]),[],"en",{ownerText:"5 employees"})!;
    expect(rendered.issues).toContainEqual(expect.objectContaining({kind:"unmatched_number",text:claim}));
  });
  it("keeps a generated echo that omits the owner's currency symbol",()=>{
    const rendered=renderInvestigationAnswer(answer([{kind:"advice",text:"Consider 5.",citations:[]}]),[],"en",{ownerText:"$5"})!;
    expect(rendered.issues).toEqual([]);
  });
  it("checks an Arabic decimal/grouped value as one claim rather than numeric fragments",()=>{
    const rendered=renderInvestigationAnswer(answer([{kind:"advice",text:"السعر ١٬٦١٠٫٢٥ دولار.",citations:[]}]),[],"ar")!;
    expect(rendered.issues).toEqual([expect.objectContaining({kind:"unmatched_number",text:"١٬٦١٠٫٢٥ دولار"})]);
    expect(rendered.blocks).toEqual([{type:"text",text:"السعر [قيمة غير مؤكدة]."}]);
  });
  it("never echoes the fractional tail of a grouped Arabic owner amount as a whole money value",()=>{
    const rendered=renderInvestigationAnswer(answer([{kind:"advice",text:"Consider 25 dollars.",citations:[]}]),[],"ar",{ownerText:"١٬٦١٠٫٢٥ دولار"})!;
    expect(rendered.issues).toHaveLength(1);
  });
  it("keeps a complete Arabic owner amount with compatible units",()=>{
    const rendered=renderInvestigationAnswer(answer([{kind:"advice",text:"السعر ١٬٦١٠٫٢٥ دولار.",citations:[]}]),[],"ar",{ownerText:"١٬٦١٠٫٢٥ دولار"})!;
    expect(rendered.issues).toEqual([]);
  });
  it("never attaches evidence or cautions from an unused declared pointer",()=>{
    const source=observation("r2","priceCents",1000,{quality:{estimatedInputs:["price"]}});
    source.reference={...ref("external-price"),source:"unverified_external"};
    const a=answer([{kind:"advice",text:"The modeled value is $5.",citations:[],formulas:[{
      claim:"$5",formula:"a",variables:[{name:"a",value:5,source:"r1:value.priceCents"},{name:"b",value:10,source:"r2:value.priceCents"}]}]}]);
    const used=observation("r1","priceCents",500);
    const rendered=renderInvestigationAnswer(a,[used,source],"en")!;
    expect(rendered.issues).toContainEqual(expect.objectContaining({kind:"formula_failed",failure:{reason:"unused_variable",variable:"b"}}));
    expect(rendered.citedIds).toEqual([]);
    const reply=investigationReply(a,[used,source],"en")!;
    expect(reply.evidence).toEqual([]);
    expect(reply.blocks).not.toContainEqual(expect.objectContaining({code:"SUPERVISOR_PUBLIC_RESEARCH"}));
    expect(reply.blocks).not.toContainEqual(expect.objectContaining({code:"SUPERVISOR_ESTIMATED"}));
  });
});

describe("self-review: whole decimal and signed claim spans",()=>{
  it.each([".50 dollars","- $5","$-5"])("checks the complete generated span %s",claim=>{
    const rendered=renderInvestigationAnswer(answer([{kind:"advice",text:"Consider "+claim+".",citations:[]}]),[],"en")!;
    expect(rendered.issues).toEqual([expect.objectContaining({kind:"unmatched_number",text:claim})]);
  });
});


describe("PR127 Unicode owner-specific facts and modifier-resistant echoes",()=>{
  it.each([
    ["en","This café has $5 of profit.","$5"],
    ["es","Tu café tiene una ganancia de $5.","$5"],
    ["es","Esta cafetería tiene $5 de ganancias.","$5"],
    ["ar","ربحك هو $5.","$5"],
  ] as const)("does not accept uncited business result in %s", (locale,text,ownerText)=>{
    const rendered=renderInvestigationAnswer(answer([{kind:"advice",text,citations:[]}]),[],locale,{ownerText})!;
    expect(rendered.issues).toContainEqual(expect.objectContaining({kind:"business_claim_uncited"}));
  });
  it.each([
    ["en","Schedule 5 new employees."],
    ["es","Programa 5 nuevos empleados."],
    ["ar","جدول 5 من الموظفين."],
    ["en","Hire 5 very experienced baristas."],
  ] as const)("does not treat $5 as a quantity in %s", (locale,text)=>{
    const rendered=renderInvestigationAnswer(answer([{kind:"advice",text,citations:[]}]),[],locale,{ownerText:"$5"})!;
    expect(rendered.issues).toContainEqual(expect.objectContaining({kind:"unmatched_number"}));
  });
  it("never echoes an owner-written Unicode negative as a positive",()=>{
    const rendered=renderInvestigationAnswer(answer([{kind:"advice",text:"Consider $5.",citations:[]}]),[],"en",{ownerText:"−$5"})!;
    expect(rendered.issues).toContainEqual(expect.objectContaining({kind:"unmatched_number"}));
  });
  it("keeps a literal negative echo with a Unicode minus",()=>{
    const rendered=renderInvestigationAnswer(answer([{kind:"advice",text:"Consider −$5.",citations:[]}]),[],"en",{ownerText:"−$5"})!;
    expect(rendered.issues).toEqual([]);
  });
});


describe("PR127 unitless typed-owner echo requires neutral context on BOTH sides",()=>{
  it.each([
    ["en","Recommended employees: 5."],
    ["en","Recommended new employees: 5."],
    ["es","Empleados recomendados: 5."],
    ["ar","عدد الموظفين: 5."],
    ["en","Hire 5 new employees."],
  ] as const)("masks relabeled typed owner amount in %s", (locale,text)=>{
    const out=renderInvestigationAnswer(answer([{kind:"advice",text,citations:[]}]),[],locale,{ownerText:"$5"})!;
    expect(out.issues).toContainEqual(expect.objectContaining({kind:"unmatched_number",text:"5"}));
  });
  it.each(["$5","5%"])("keeps a neutral standalone echo of an owner typed %s",ownerText=>{
    const out=renderInvestigationAnswer(answer([{kind:"advice",text:"Consider 5.",citations:[]}]),[],"en",{ownerText})!;
    expect(out.issues).toEqual([]);
  });
  it.each([
    ["en","Our café has profit of $5."],
    ["es","Mi ganancia es $5."],
    ["es","Mis ventas son $5."],
  ] as const)("guards additional own-business phrasing in %s", (locale,text)=>{
    const out=renderInvestigationAnswer(answer([{kind:"advice",text,citations:[]}]),[],locale,{ownerText:"$5"})!;
    expect(out.issues).toContainEqual(expect.objectContaining({kind:"business_claim_uncited"}));
  });
});


describe("PR127 atomic owner date/time and unrestricted Spanish possessives",()=>{
  it.each([
    ["2026-10-19","2026-19-10"],
    ["10/19/2026","19/10/2026"],
    ["10/19","19/10"],
    ["10:30","30:10"],
    ["2026-10-19T10:30","2026-10-19T30:10"],
  ])("rejects reassembled temporal claim %s -> %s", (ownerText,claim)=>{
    const rendered=renderInvestigationAnswer(answer([{kind:"advice",text:"Consider "+claim+".",citations:[]}]),[],"en",{ownerText})!;
    expect(rendered.issues).toContainEqual(expect.objectContaining({kind:"unmatched_number",text:claim}));
    expect(JSON.stringify(rendered.blocks)).not.toContain(claim);
  });
  it.each(["2026-10-19","10/19/2026","10/19","10:30","2026-10-19T10:30"])(
    "keeps the owner's unchanged structured temporal value %s",claim=>{
      const rendered=renderInvestigationAnswer(answer([{kind:"advice",text:"Consider "+claim+".",citations:[]}]),[],"en",{ownerText:claim})!;
      expect(rendered.issues).toEqual([]);
    });
  it("does not treat date components as independently quoted numbers",()=>{
    const rendered=renderInvestigationAnswer(answer([{kind:"advice",text:"Consider 19.",citations:[]}]),[],"en",{ownerText:"2026-10-19"})!;
    expect(rendered.issues).toContainEqual(expect.objectContaining({kind:"unmatched_number",text:"19"}));
  });
  it.each(["Mis empleados cuestan $5.","Mi alquiler es $5.","Tu proveedor cobra $5."])(
    "requires an actual citation for Spanish owner facts: %s",text=>{
      const rendered=renderInvestigationAnswer(answer([{kind:"advice",text,citations:[]}]),[],"es",{ownerText:"Assume $5."})!;
      expect(rendered.issues).toContainEqual(expect.objectContaining({kind:"business_claim_uncited",text:"$5"}));
    });
});
