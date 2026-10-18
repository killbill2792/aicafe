import {describe,it,expect} from "vitest";
import {observationDisplay,renderInvestigationAnswer,renderUnverifiedAnswer,type Observation} from "./evidence";
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
  it("rescues an evidence answer that cites real data but also wrote a stray raw number",()=>{
    const o=observation("r1","priceCents",525);
    const rescued=renderUnverifiedAnswer(answer([
      {kind:"evidence",text:"The listed price is {{r1:value.priceCents}} for 2 drinks.",citations:["r1"]},
    ]),[o],"en");
    expect(rescued).toEqual({text:"The listed price is [unchecked value] for 2 drinks.",citedIds:["r1"]});
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
