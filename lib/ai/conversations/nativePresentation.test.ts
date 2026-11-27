import {describe,it,expect,vi} from "vitest";
import {shadcnComponentDefinitions} from "@json-render/shadcn/catalog";
import {shadcnComponents} from "@json-render/shadcn";
import {resolveResearchSpec,INLINE_PRESENTATION_HINT} from "@/lib/ai/research/presentation";
import {recoverRichPresentation,presentationDataLines} from "./presentation";
import {upstreamComponents,validNativeSpec,createLocalWidgetStore,nativeFunctions,nativeRenderProps,readNativeSnapshot,parseUpstreamProps} from "./nativePresentation";
import {resolveElementProps} from "@json-render/core";
import manifest from "../../../package.json";
vi.mock("server-only",()=>({}));
const ctx={asOf:"2026-11-25",currency:"USD"};
const make=(elements:Record<string,unknown>,state:Record<string,unknown>={},root="root")=>({root,elements,state});
const patches=(spec:ReturnType<typeof make>)=>[{op:"add",path:"/root",value:spec.root},{op:"add",path:"/state",value:spec.state},...Object.entries(spec.elements).map(([key,value])=>({op:"add",path:"/elements/"+key,value}))];
const node=(type:string,props:Record<string,unknown>,children:string[]=[])=>({type,props,children});
describe("Installed native Luna catalog",()=>{
 it("has no manually curated component subset; definitions, implementations and model prompt match after every upgrade",()=>{
  const names=Object.keys(shadcnComponentDefinitions).sort();
  expect(Object.keys(upstreamComponents).sort()).toEqual(names);
  expect(Object.keys(shadcnComponents).sort()).toEqual(names);
  for(const name of names)expect(INLINE_PRESENTATION_HINT).toContain(name+":");
  const deps=manifest.dependencies;
  expect(deps["@json-render/core"]).toBe(deps["@json-render/react"]);
  expect(deps["@json-render/shadcn"]).toBe(deps["@json-render/core"]);
 });
 it("streams native state, layouts, editable bindings, conditional and repeated nodes alongside financial snapshots",()=>{
  const spec=make({
   root:node("Card",{title:"$10,000 scenario"},["slider","text","list","chart","data"]),
   slider:node("Slider",{label:"Growth",value:{$bindState:"/factor"},min:0,max:2,step:0.1}),
   text:node("Text",{text:{$computed:"format",args:{value:{$state:"/sales"},currency:"USD"}}}),
   list:{...node("Stack",{},["row"]),repeat:{statePath:"/items",key:"id"}},
   row:{...node("Text",{text:{$item:"label"}}),visible:{$item:"show",eq:true}},
   chart:node("LunaChart",{kind:"bar",title:"Forecast",currency:"USD",unit:"cents",points:[{label:"Revenue",value:{$state:"/sales"}}]}),
   data:node("DataView",{panels:[{kind:"metric",title:"Recorded",unit:"cents",points:[{label:"Sales",value:1000000}]}]}),
  },{sales:1000000,factor:1.1,items:[{id:"1",label:"August",show:true}]});
  const blocks=resolveResearchSpec(patches(spec),new Map(),ctx);
  expect(blocks).toHaveLength(1);const saved=blocks[0].nativeSpec!;
  expect(saved.state).toEqual(spec.state);expect(saved.elements.slider.props.value).toEqual({$bindState:"/factor"});
  expect(saved.elements.list.repeat).toEqual({statePath:"/items",key:"id"});expect(saved.elements.data.type).toBe("LunaSnapshot");
  expect(recoverRichPresentation(readNativeSnapshot(saved.elements.data.props.snapshotJSON))?.panels[0].points[0].value).toBe(1000000);
  expect(recoverRichPresentation(JSON.parse(JSON.stringify(blocks[0])))?.nativeSpec).toEqual(saved);
  expect(presentationDataLines(blocks[0]).join("\n")).toContain("Recorded");
 });
 it("supports deeply nested acyclic layouts but rejects cycles, unregistered actions and automatic watch loops",()=>{
  const elements=Object.fromEntries(Array.from({length:45},(_,i)=>["n"+i,node(i===44?"Text":"Stack",i===44?{text:"Retained"}:{},i===44?[]:["n"+(i+1)])]));
  const spec=make(elements,{},"n0");expect(validNativeSpec(spec)).toBe(true);
  expect(validNativeSpec(make({...elements,n44:node("Stack",{},["n0"])},{},"n0"))).toBe(false);
  expect(validNativeSpec(make({root:{...node("Button",{label:"Delete"}),on:{press:{action:"deleteBusiness"}}}}))).toBe(false);
  expect(validNativeSpec(make({root:{...node("Text",{text:"x"}),watch:{"/x":{action:"setState",params:{statePath:"/y",value:1}},"/y":{action:"setState",params:{statePath:"/x",value:1}}}}}))).toBe(false);
 });
 it("keeps local controls isolated, blocks prototype writes and automatic external requests",()=>{
  const store=createLocalWidgetStore({factor:1.1});store.set("/factor",1.2);expect(store.get("/factor")).toBe(1.2);
  store.set("/constructor/prototype/polluted",true);store.update({"/__proto__/polluted":true});
  expect(({} as {polluted?:boolean}).polluted).toBeUndefined();expect(store.get("/constructor")).toBeUndefined();
  const arrays=createLocalWidgetStore({items:[1,2]});arrays.set("/items/00",99);expect(arrays.get("/items/0")).toBe(1);
  expect(validNativeSpec(make({root:{...node("Text",{text:"x"}),watch:{"/items/0":{action:"setState",params:{statePath:"/items/00",value:{$state:"/items"}}}}}},{items:[1]}))).toBe(false);
  expect(nativeRenderProps({href:"javascript:alert(1)",src:"https://example.com/private",className:"fixed bg-[url(https://example.com)] text-sm"})).toEqual({href:"#",src:null,className:"text-sm"});
  expect(nativeRenderProps({href:"https://example.com"}).href).toBe("https://example.com/");
  expect(parseUpstreamProps("Slider",{label:"Growth",value:1.2,min:0,max:2,step:0.1})?.success).toBe(true);
  expect(parseUpstreamProps("Slider",{label:"Growth",value:"wrong"})?.success).toBe(false);
 });
 it("preserves native accounting table cells instead of dropping numeric or unknown values",()=>{
  const parsed=parseUpstreamProps("Table",{columns:["Account","Amount","Recorded"],rows:[["Sales",120.25,true],["Refund",-12.5,false],["Zero",0,null],["Missing"]],caption:"Ledger"});
  expect(parsed?.success).toBe(true);
  if(!parsed?.success)throw Error("table must render");
  expect(parsed.data).toMatchObject({columns:["Account","Amount","Recorded"],rows:[["Sales","120.25","true"],["Refund","-12.5","false"],["Zero","0","Not recorded"],["Missing","Not recorded","Not recorded"]]});
  expect(parseUpstreamProps("Table",{columns:["Account"],rows:[[{unrenderable:true}]]})).toMatchObject({success:true,data:{rows:[['{"unrenderable":true}']]}});
  expect(parseUpstreamProps("Text",{text:125})).toMatchObject({success:true,data:{text:"125"}});
  expect(parseUpstreamProps("Slider",{label:"Growth",value:"1.2",min:0,max:2,step:0.1})).toMatchObject({success:true,data:{value:1.2}});
 });
 it("recalculates exact arbitrary formulas from bound local inputs without SQL evidence",()=>{
  const expression={text:{$computed:"calculate",args:{inputs:[{name:"sales",unit:"cents",value:{$state:"/sales"}},{name:"factor",unit:"ratio",value:{$state:"/factor"}}],steps:[{id:"forecast",op:"multiply",args:["sales","factor"]}]}}};
  expect(resolveElementProps(expression,{stateModel:{sales:4328006,factor:1.2},functions:nativeFunctions}).text).toBe(5193607);
  expect(resolveElementProps(expression,{stateModel:{sales:4328006,factor:0},functions:nativeFunctions}).text).toBe(0);
 });
 it("retains a valid native sibling and adapts an unknown widget without an additional model call",()=>{
  const s=make({root:node("Stack",{},["statement","text"]),statement:node("IncomeStatement",{title:"Profit and loss",columns:["Account","Amount"],rows:[["Sales",1000],["Costs",-500]]}),text:node("Text",{text:"Keep this explanation"})});
  const blocks=resolveResearchSpec(patches(s),new Map(),ctx);
  expect(blocks).toHaveLength(1);
  const native=blocks[0].nativeSpec!;
  expect(native.elements.statement).toMatchObject({type:"LunaFallback",props:{values:{title:"Profit and loss",rows:[["Sales",1000],["Costs",-500]]}}});
  expect(native.elements.text.props.text).toBe("Keep this explanation");
  expect(presentationDataLines(blocks[0]).join("\n")).toContain("1000");
  expect(presentationDataLines(blocks[0])).toContain("Keep this explanation");
 });
 it("retains native text without requiring a data reference or a successful SQL read",()=>{
  const s=make({root:node("Text",{text:"My estimate is $47,608.07"})});
  const blocks=resolveResearchSpec(patches(s),new Map(),ctx);expect(blocks[0].nativeSpec).toBeDefined();
  expect(presentationDataLines(blocks[0])).toContain("My estimate is $47,608.07");
 });
 it("exports only visible branches and expands repeat item and nested scopes",()=>{
  const s=make({
   root:node("Stack",{},["actual","forecast","list"]),
   actual:{...node("Text",{text:"Actual 10"}),visible:{$state:"/actual",eq:true}},
   forecast:{...node("Text",{text:"Forecast 20"}),visible:{$state:"/actual",eq:false}},
   list:{...node("Stack",{},["row","nested"]),repeat:{statePath:"/items"},visible:{$item:"show",eq:true}},
   row:node("Text",{text:{$template:"${name}: ${amount}"}}),
   nested:{...node("Stack",{},["child"]),repeat:{statePath:{$item:"children"}}},
   child:node("Text",{text:{$item:"label"}}),
  },{actual:true,items:[{name:"August",amount:10,show:true,children:[{label:"First"}]},{name:"September",amount:20,show:true,children:[{label:"Second"}]},{name:"Hidden",amount:30,show:false,children:[]}]});
  const lines=presentationDataLines(resolveResearchSpec(patches(s),new Map(),ctx)[0]);
  expect(lines).toEqual(["Actual 10","August: 10","First","September: 20","Second"]);
 });
 it("does not accept a model-supplied internal snapshot node",()=>{
  const s=make({root:node("LunaSnapshot",{snapshotJSON:JSON.stringify({type:"rich_presentation",version:1,layout:"stack",panels:[],suggestions:[]})})});
  expect(resolveResearchSpec(patches(s),new Map(),ctx)).toEqual([]);
 });
});
