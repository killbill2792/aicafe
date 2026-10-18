import {describe,it,expect} from "vitest";
import {observationDisplay,renderInvestigationAnswer,type Observation} from "./evidence";
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
  it("caps boxed facts at four even with five distinct money citations",()=>{
    const observations=[1,2,3,4,5].map(n=>observation("r"+n,"priceCents",n*100));
    const paragraphs=observations.map(o=>(
      {kind:"evidence" as const,text:"Price {{"+o.id+":value.priceCents}}.",citations:[o.id]}));
    const rendered=renderInvestigationAnswer(answer(paragraphs),observations,"en");
    const boxes=rendered!.blocks.filter(b=>b.type==="metric"||b.type==="percent");
    expect(boxes).toHaveLength(4);
  });
});
