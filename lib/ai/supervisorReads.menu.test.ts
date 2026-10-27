import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
import {supervisorHistoricalReaders} from "./supervisorReads.server";

const business="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const group="toast:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:milk";
function fakeDb(){
 const reads:string[]=[];
 const from=(table:string)=>{
  let businessFilter:string|null=null;
  const q={
   select:()=>q,
   eq:(key:string,value:string)=>{if(key==="business_id")businessFilter=value;return q;},
   in:()=>q,order:()=>q,
   limit:async()=>{
    reads.push(table);
    if(businessFilter!==business)throw new Error("Unscoped menu reader");
    if(table==="menu_items")return {error:null,data:[
     {id:"open",name:"Custom Drink",base_name:"Custom Drink",size_label:null,
      category:"drink",is_active:true,price_cents:null,description:"Made to order",
      menu_group:"Drinks / Custom",pos_visibility:"POS",pos_pricing_strategy:"OPEN_PRICE"},
     {id:"priced",name:"Latte",base_name:"Latte",size_label:"Large",
      category:"drink",is_active:true,price_cents:500,description:"Milk espresso",
      menu_group:"Drinks / Coffee",pos_visibility:"POS,ONLINE",pos_pricing_strategy:"SIZE_PRICE"},
    ]};
    if(table==="menu_item_modifier_groups")return {error:null,data:[
     {menu_item_id:"open",pos_group_id:group,pos_group_name:"Milk",
      min_selections:0,max_selections:1,required:false},
     {menu_item_id:"priced",pos_group_id:group,pos_group_name:"Milk",
      min_selections:0,max_selections:1,required:false},
    ]};
    if(table==="modifier_recipes")return {error:null,data:[
     {pos_group_id:group,name:"Oat milk",price_cents:80,is_active:true},
     {pos_group_id:group,name:"Half-and-half",price_cents:null,is_active:true},
     {pos_group_id:group,name:"Retired",price_cents:0,is_active:false},
    ]};
    throw new Error("Unexpected table "+table);
   }
  };
  return q;
 };
 return {client:{from} as unknown as SupabaseClient,reads};
}
describe("Supervisor published POS menu evidence",()=>{
 it("keeps OPEN_PRICE unknown and exposes per-item group and add-on prices",async()=>{
  const {client,reads}=fakeDb();
  const result=await supervisorHistoricalReaders(client,business).menuCatalog(business);
  expect(result.available).toBe(true);
  if(!result.available)return;
  const open=result.value.find(x=>x.id==="open");
  expect(open).toMatchObject({priceCents:null,pricingStrategy:"OPEN_PRICE",
   description:"Made to order",menuGroup:"Drinks / Custom",
   modifierGroups:[{id:group,name:"Milk",required:false,options:[
    {name:"Oat milk",priceCents:80},{name:"Half-and-half",priceCents:null}
   ]}]});
  expect(result.value.find(x=>x.id==="priced")).toMatchObject({
   priceCents:500,sizeLabel:"Large",modifierGroups:[{name:"Milk"}]});
  expect(reads).toEqual(["menu_items","menu_item_modifier_groups","modifier_recipes"]);
 });
 it("rejects cross-business readers before touching database",async()=>{
  const {client,reads}=fakeDb();
  await expect(supervisorHistoricalReaders(client,business).menuCatalog(
   "cccccccc-cccc-4ccc-8ccc-cccccccccccc"))
   .rejects.toThrow("scope mismatch");
  expect(reads).toHaveLength(0);
 });
});
