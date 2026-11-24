import {describe,expect,it} from "vitest";
import {allowedFunctionNames,canonicalHostedOutput,projectProviderTools,usesNativeToolSearch,validProviderFunctionCall} from "./providerTools";
const a={type:"function",name:"get_menu_items",strict:true,description:"Menu",parameters:{type:"object",properties:{},additionalProperties:false,required:[]}};
const b={...a,name:"get_sales_summary"};
const search={type:"tool_search_call",execution:"server",call_id:null,status:"completed",arguments:{paths:[a.name]}};
const output=(tools:unknown[])=>({type:"tool_search_output",execution:"server",call_id:null,status:"completed",tools});
describe("native discovery uses only the admitted existing registry",()=>{
 it("defers schema, preserves old providers, and does not mutate its registry",()=>{
   expect(usesNativeToolSearch("gpt-6-luna",false)).toBe(true);
   expect(usesNativeToolSearch("gpt-6-luna",true)).toBe(false);
   expect(usesNativeToolSearch("gpt-4.1-mini",false)).toBe(false);
   expect(projectProviderTools([a,b],true)).toEqual([{...a,defer_loading:true},{...b,defer_loading:true},{type:"tool_search"}]);
   expect(projectProviderTools([a,b],false)).toEqual([a,b]);
   expect(allowedFunctionNames([a,b])).toEqual(new Set([a.name,b.name]));
   expect(()=>projectProviderTools([a,a],true)).toThrow("invalid_provider_tool_registry");
 });
 it("makes the three authorized research primitives immediately callable, without a discovery round",()=>{
   const core=["describe_data","query_data","calculate"].map(name=>({...a,name}));
   expect(projectProviderTools([...core,b],true)).toEqual([...core,{...b,defer_loading:true},{type:"tool_search"}]);
   expect(projectProviderTools([b],true)).not.toContainEqual(core[0]);
 });
 it("replays canonical declarations rather than provider-injected parameters",()=>{
   const registry=projectProviderTools([a],true);
   expect(canonicalHostedOutput([search,output([{...a,parameters:{evil:true}}])],registry,true)).toEqual([search,output([{...a,defer_loading:true}])]);
   expect(canonicalHostedOutput([search,output([])],registry,true)).toEqual([search,output([])]);
   expect(()=>canonicalHostedOutput([search,output([b])],registry,true)).toThrow();
   expect(()=>canonicalHostedOutput([output([a])],registry,true)).toThrow();
   expect(()=>canonicalHostedOutput([search],registry,true)).toThrow();
   expect(()=>canonicalHostedOutput([search,output([a])],registry,false)).toThrow();
   expect(()=>canonicalHostedOutput([{...search,execution:"client"},output([a])],registry,true)).toThrow();
 });
 it("accepts a valid flat call and rejects namespace substitution",()=>{
   const call={type:"function_call",name:a.name,call_id:"call_x",arguments:"{}"};
   expect(validProviderFunctionCall({...call,namespace:a.name})).toBe(true);
   expect(validProviderFunctionCall({...call,namespace:b.name})).toBe(false);
   expect(validProviderFunctionCall({...call,call_id:""})).toBe(false);
   expect(validProviderFunctionCall({...call,arguments:{}})).toBe(false);
 });
});
