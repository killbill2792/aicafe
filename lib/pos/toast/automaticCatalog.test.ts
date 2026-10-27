import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const request=vi.hoisted(()=>vi.fn());
vi.mock("./client",async(importOriginal)=>{
 const original=await importOriginal<typeof import("./client")>();
 return {...original,createToastClient:()=>({request})};
});
import {createToastAdapter} from "./adapter";
import type {SupabaseClient} from "@supabase/supabase-js";
const rg="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const itemGuid="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sizeGuid="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const gid="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const op=(n:number)=>"eeeeeeee-eeee-4eee-8eee-"+String(n).padStart(12,"0");
const adapter=createToastAdapter({db:{} as SupabaseClient,businessId:rg,restaurantGuid:rg});
const menu={restaurantGuid:rg,menus:[{name:"Drinks",menuGroups:[{
 name:"Coffee",menuItems:[{
 guid:itemGuid,name:"Latte",description:"Espresso and milk",price:null,
 pricingStrategy:"SIZE_PRICE",pricingRules:{sizeSpecificPricingGuid:sizeGuid},
 modifierGroupReferences:[1,2],visibility:["POS","ONLINE"]
 }],menuGroups:[{name:"Iced",menuItems:[{
 guid:op(8),name:"Cold Brew",pricingStrategy:"OPEN_PRICE",price:null,
 modifierGroupReferences:[]}],menuGroups:[]}]
 }]}],modifierGroupReferences:{
 "1":{guid:sizeGuid,name:"Size",minSelections:1,maxSelections:1,requiredMode:"REQUIRED",modifierOptionReferences:[10,11,12]},
 "2":{guid:gid,name:"Milk",minSelections:0,maxSelections:1,modifierOptionReferences:[13]}
 },modifierOptionReferences:{
 "10":{guid:op(10),name:"Small",price:3,pricingStrategy:"BASE_PRICE"},
 "11":{guid:op(11),name:"Medium",price:4,pricingStrategy:"BASE_PRICE"},
 "12":{guid:op(12),name:"Large",price:5,pricingStrategy:"BASE_PRICE"},
 "13":{guid:op(13),name:"Oat",price:0.8,pricingStrategy:"BASE_PRICE"}
 }};
describe("Toast published catalog adapter",()=>{
 beforeEach(()=>request.mockReset());
 it("keeps size GUID identities, cent prices, group paths and priced options",async()=>{
  request.mockResolvedValue(menu);
  const rows=await adapter.fetchCatalogItems();
  expect(rows).toHaveLength(4);
  const sizes=rows.filter(r=>r.baseName==="Latte");
  expect(sizes.map(x=>x.priceCents)).toEqual([300,400,500]);
  expect(sizes.map(x=>x.sizeLabel)).toEqual(["Small","Medium","Large"]);
  expect(sizes[0].posItemId).toBe("toast:"+rg+":"+itemGuid+":size:"+op(10));
  expect(sizes[0].description).toBe("Espresso and milk");
  expect(sizes[0].menuGroup).toBe("Drinks / Coffee");
  expect(sizes[0].modifierGroups?.[1].options[0].priceCents).toBe(80);
  expect(rows.find(x=>x.name==="Cold Brew")).toMatchObject({
   priceCents:null,pricingStrategy:"OPEN_PRICE",menuGroup:"Drinks / Coffee / Iced"
  });
 });
 it("reads Toast documented time-specific base price and preserves raw modifier strategy",async()=>{
  const snapshot=structuredClone(menu) as unknown as {menus:Array<{menuGroups:Array<{
   menuItems:Record<string,unknown>[]}>}>;modifierOptionReferences:Record<string,Record<string,unknown>>};
  snapshot.menus[0].menuGroups[0].menuItems.push({
   guid:op(31),name:"Lunch Soup",price:null,pricingStrategy:"TIME_SPECIFIC_PRICE",
   pricingRules:{timeSpecificPricingRules:[
    {timeSpecificPrice:4,basePrice:9,schedule:[]},
    {timeSpecificPrice:6,basePrice:9,schedule:[]}
   ]},modifierGroupReferences:[]});
  snapshot.menus[0].menuGroups[0].menuItems.push({
   guid:op(32),name:"Different Bases",price:null,pricingStrategy:"TIME_SPECIFIC_PRICE",
   pricingRules:{timeSpecificPricingRules:[
    {timeSpecificPrice:4,basePrice:9,schedule:[]},
    {timeSpecificPrice:5,basePrice:10,schedule:[]}
   ]},modifierGroupReferences:[]});
  snapshot.modifierOptionReferences["13"].pricingStrategy="GROUP_PRICE";
  snapshot.modifierOptionReferences["13"].price=null;
  request.mockResolvedValue(snapshot);
  const items=await adapter.fetchCatalogItems();
  expect(items.find(x=>x.name==="Lunch Soup")).toMatchObject({
   priceCents:900,pricingStrategy:"TIME_SPECIFIC_PRICE"});
  expect(items.find(x=>x.name==="Different Bases")).toMatchObject({
   priceCents:null,pricingStrategy:"TIME_SPECIFIC_PRICE"});
  expect(items.find(x=>x.name==="Cold Brew")?.priceCents).toBeNull();
  const oat=items.find(x=>x.baseName==="Latte")?.modifierGroups?.[1].options[0];
  expect(oat?.priceCents).toBeNull();
  expect(oat?.pricingStrategy).toBe("GROUP_PRICE");
  expect(oat?.posMetadata?.guid).toBe(op(13));
 });
 it("maps Toast job title and wage without excluding deleted staff from roster",async()=>{
  const person="ffffffff-ffff-4fff-8fff-ffffffffffff";
  request.mockImplementation(async(path:string)=>(path??"").includes("/jobs")?
   [{guid:gid,title:"Barista",defaultWage:18.5,wageFrequency:"HOURLY"}]:
   [{guid:person,firstName:"Maria",lastName:"Lopez",deleted:true,jobReferences:[{guid:gid}]}]);
  expect(await adapter.fetchEmployees()).toEqual([{
   posTeamMemberId:"toast:"+rg+":"+person,displayName:"Maria Lopez",
   posName:"Maria Lopez",role:"Barista",hourlyWageCents:1850,active:false
  }]);
 });
});
