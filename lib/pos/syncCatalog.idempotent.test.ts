import {describe,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {PosAdapter,PosCatalogItem} from "./types";
vi.mock("server-only",()=>({}));
import {syncCanonicalCatalog,applyPublishedToastCatalogReceipt} from "./syncCatalog";

const business="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const product="square:variation-101";
const modifier="square:modifier-202";
function fixture(){
 const tables:Record<string,Array<Record<string,unknown>>> = {
  menu_items:[],menu_item_modifier_groups:[],modifier_recipes:[],
  pos_item_aliases:[],pos_catalog_matches:[],toast_catalog_facts:[],
 };
 let writes=0,serial=0;
 const db={rpc:async()=>({error:null}),from(table:string){
  let action:"read"|"upsert"|"update"|"delete"="read";
  let values:Record<string,unknown>={};
  const filters:Record<string,unknown>={};
  const q={
   select:()=>q,eq:(key:string,value:unknown)=>{filters[key]=value;return q;},
   not:()=>q,is:()=>q,like:()=>q,order:()=>q,
   upsert:(v:Record<string,unknown>)=>{action="upsert";values=v;return q;},
   update:(v:Record<string,unknown>)=>{action="update";values=v;return q;},
   delete:()=>{action="delete";return q;},
   range:async(from:number,to:number)=>({data:read().slice(from,to+1),error:null}),
   single:async()=>run(),
   then:(yes:(v:unknown)=>unknown)=>Promise.resolve(run()).then(yes),
  };
  function read(){
   return (tables[table]??[]).filter(row=>Object.entries(filters).every(([k,v])=>row[k]===v));
  }
  function run(){
   if(action==="read")return {data:read(),error:null};
   writes++;
   if(action==="delete"){tables[table]=tables[table].filter(r=>!read().includes(r));return {error:null};}
   if(action==="update"){for(const row of read())Object.assign(row,values);return {error:null};}
   const key=table==="menu_items"?"pos_item_id":table==="modifier_recipes"?
    "pos_modifier_id":table==="menu_item_modifier_groups"?"pos_group_id":"pos_item_id";
   let row=(tables[table]??[]).find(r=>r[key]===values[key]);
   if(row)Object.assign(row,values);
   else{
    row={...values,id:"00000000-0000-4000-8000-"+(++serial).toString().padStart(12,"0")};
    (tables[table]??=[]).push(row);
   }
   return {data:{id:row.id},error:null};
  }
  return q;
 }};
 return {db:db as unknown as SupabaseClient,tables,get writes(){return writes;}};
}
describe("shared POS catalog idempotency",()=>{
 it("imports once and performs zero writes when JSONB keys arrive reordered",async()=>{
  const f=fixture();let requests=0;
  const adapter={provider:"square",fetchCatalogItems:async()=>{
   requests++;
   const flipped=requests%2===0;
   const metadata=flipped?{nested:{z:2,a:1},guid:"123"}:
    {guid:"123",nested:{a:1,z:2}};
   return [{
    posItemId:product,name:"Open-price latte",baseName:"Open-price latte",
    sizeLabel:null,priceCents:null,category:"drink",description:"Choose your size",
    menuGroup:"Coffee",visibility:"POS",pricingStrategy:"OPEN_PRICE",
    posMetadata:metadata,
    modifierGroups:[{posGroupId:"square:group-1",name:"Milk",
      minSelections:0,maxSelections:1,required:false,posMetadata:metadata,
      options:[{posModifierId:modifier,name:"Oat milk",priceCents:80,
       pricingStrategy:"BASE_PRICE",posMetadata:metadata}]}]
   } satisfies PosCatalogItem];
  }} as unknown as PosAdapter;
  const first=await syncCanonicalCatalog(f.db,business,adapter);
  expect(first).toMatchObject({created:1,needsReview:0});
  expect(f.tables.menu_items).toHaveLength(1);
  expect(f.tables.modifier_recipes).toHaveLength(1);
  const firstWrites=f.writes;
  expect(firstWrites).toBeGreaterThan(0);
  const again=await syncCanonicalCatalog(f.db,business,adapter);
  expect(again.changed).toBe(0);
  expect(f.writes).toBe(firstWrites);
  expect(f.tables.menu_items).toHaveLength(1);
  expect(f.tables.menu_item_modifier_groups).toHaveLength(1);
  expect(f.tables.modifier_recipes).toHaveLength(1);
 });
});

describe("multi-location catalog archive safety",()=>{
 it("keeps an item published by another Square location, but archives it after a complete single-location snapshot",async()=>{
  const f=fixture();let available=true;
  const adapter={provider:"square",fetchCatalogItems:async()=>available?[{
   posItemId:"square:location-only",name:"Location special",
   priceCents:null,category:"drink",description:null
  } satisfies PosCatalogItem]:[]} as unknown as PosAdapter;
  await syncCanonicalCatalog(f.db,business,adapter);
  expect(f.tables.menu_items).toHaveLength(1);
  available=false;
  const protectedResult=await syncCanonicalCatalog(f.db,business,adapter,{archiveMissing:false});
  expect(protectedResult.changed).toBe(0);
  expect(f.tables.menu_items[0].is_active).toBe(true);
  const archived=await syncCanonicalCatalog(f.db,business,adapter);
  expect(archived.changed).toBe(1);
  expect(f.tables.menu_items[0].is_active).toBe(false);
 });
});

describe("Toast catalog GUID identity without owner clicks",()=>{
 it("creates distinct published GUIDs on ambiguous names and reruns without duplicates",async()=>{
  const f=fixture();
  f.tables.menu_items.push({id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001",
   business_id:business,pos_item_id:null,name:"Latte",base_name:"Latte",
   size_label:null,price_cents:500,category:"drink",catalog_source:"manual",
   pos_name:null,is_active:true});
  const restaurant="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const guid="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const itemId="toast:"+restaurant+":"+guid;
  const optionId="toast:"+restaurant+":dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const catalog:PosCatalogItem={posItemId:itemId,name:"Latte",baseName:"Latte",
   sizeLabel:null,priceCents:null,category:"drink",
   modifierGroups:[{posGroupId:"toast:"+restaurant+":group",name:"Milk",
    minSelections:0,maxSelections:1,required:false,
    options:[{posModifierId:optionId,name:"Oat",priceCents:75,
     pricingStrategy:"BASE_PRICE"}]}]};
  const adapter={provider:"toast",fetchCatalogItems:async()=>[catalog]} as unknown as PosAdapter;
  const first=await syncCanonicalCatalog(f.db,business,adapter,{restaurantGuid:restaurant});
  expect(first).toMatchObject({created:1,needsReview:0});
  expect(f.tables.menu_items).toHaveLength(2);
  expect(f.tables.menu_items.find(row=>row.pos_item_id===null)?.name).toBe("Latte");
  expect(f.tables.modifier_recipes).toHaveLength(1);
  expect(f.tables.menu_item_modifier_groups).toHaveLength(1);
  const again=await syncCanonicalCatalog(f.db,business,adapter,{restaurantGuid:restaurant});
  expect(again).toMatchObject({created:0,needsReview:0});
  expect(f.tables.menu_items).toHaveLength(2);
  expect(f.tables.modifier_recipes).toHaveLength(1);
  expect(f.tables.menu_item_modifier_groups).toHaveLength(1);
  expect(f.tables.pos_catalog_matches).toHaveLength(0);
 });
});


describe("Toast unverified publication never retires stored histories",()=>{
 it("preserves item, modifier and group while a feed omits them, even with archiveMissing requested",async()=>{
  const f=fixture();
  const restaurant="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const itemId="toast:"+restaurant+":cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const modifierId="toast:"+restaurant+":dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const catalog:PosCatalogItem={
   posItemId:itemId,name:"Latte",baseName:"Latte",sizeLabel:null,
   priceCents:null,category:"drink",modifierGroups:[{
    posGroupId:"toast:"+restaurant+":eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    name:"Milk",minSelections:0,maxSelections:1,required:false,
    options:[{posModifierId:modifierId,name:"Oat",priceCents:75,
     pricingStrategy:"BASE_PRICE"}]
   }]
  };
  let published:PosCatalogItem[]=[catalog];
  const adapter={provider:"toast",fetchCatalogItems:async()=>published} as unknown as PosAdapter;
  const initial=await syncCanonicalCatalog(f.db,business,adapter,{restaurantGuid:restaurant});
  expect(initial.created).toBe(1);
  expect(f.tables.menu_item_modifier_groups).toHaveLength(1);
  expect(f.tables.modifier_recipes).toHaveLength(1);
  const writes=f.writes;
  published=[];
  const unverified=await syncCanonicalCatalog(f.db,business,adapter,
   {restaurantGuid:restaurant,archiveMissing:true});
  expect(unverified.changed).toBe(0);
  expect(f.writes).toBe(writes);
  expect(f.tables.menu_items[0].is_active).toBe(true);
  expect(f.tables.modifier_recipes[0].is_active).toBe(true);
  expect(f.tables.menu_item_modifier_groups).toHaveLength(1);
  published=[{...catalog,modifierGroups:[]}];
  const incomplete=await syncCanonicalCatalog(f.db,business,adapter,
   {restaurantGuid:restaurant,archiveMissing:true});
  expect(incomplete.changed).toBe(0);
  expect(f.tables.modifier_recipes[0].is_active).toBe(true);
  expect(f.tables.menu_item_modifier_groups).toHaveLength(1);
  published=[catalog];
  const replay=await syncCanonicalCatalog(f.db,business,adapter,{restaurantGuid:restaurant});
  expect(replay.created).toBe(0);
  expect(f.tables.menu_items).toHaveLength(1);
  expect(f.tables.modifier_recipes).toHaveLength(1);
  expect(f.tables.menu_item_modifier_groups).toHaveLength(1);
 });
});

describe("one verified Toast publication receipt handed to the existing POS0c copy",()=>{
 const restaurant="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
 const itemGuid="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
 const modifierGuid="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
 const groupGuid="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
 const prefix="toast:"+restaurant+":";
 const receipt={restaurantGuid:restaurant,
  publicationVersion:"2026-11-10T09:00:00Z",
  observedAt:"2026-11-10T09:00:09Z"};
 const payload=()=>({receipt,
  items:[{posItemId:prefix+itemGuid,name:"Latte",category:"drink",
   priceCents:625,modifierGroups:[{
    posGroupId:prefix+groupGuid,name:"Milk",
    minSelections:0,maxSelections:1,required:false,
    options:[{posModifierId:prefix+modifierGuid,name:"Oat",priceCents:80,
     pricingStrategy:"BASE_PRICE"}]
   }]} satisfies PosCatalogItem],
  facts:[{kind:"item" as const,provider_guid:itemGuid,name:"Latte",
   category:"Coffee",price_cents:625,pricing_strategy:"BASE_PRICE",
   modifier_group_guids:[groupGuid]}]});
 it("uses the same item, modifier and link IDs in exactly one authorized DB RPC",async()=>{
  const rpc=vi.fn().mockResolvedValue({data:{
   inactiveItems:1,inactiveModifiers:0,inactiveGroups:1},error:null});
  const result=await applyPublishedToastCatalogReceipt(
   {rpc} as unknown as SupabaseClient,business,payload());
  expect(result).toEqual({inactiveItems:1,inactiveModifiers:0,inactiveGroups:1});
  expect(rpc).toHaveBeenCalledExactlyOnceWith("toast_apply_verified_menu_presence",{
   p_business_id:business,p_restaurant_guid:restaurant,
   p_version:receipt.publicationVersion,p_observed_at:receipt.observedAt,
   p_item_ids:[prefix+itemGuid],p_modifier_ids:[prefix+modifierGuid],
   p_group_links:[{item_pos_id:prefix+itemGuid,pos_group_id:prefix+groupGuid}]
  });
 });
 it("fails before database mutation for another café's item or modifier",async()=>{
  const rpc=vi.fn();
  const cross=payload();
  cross.items[0].posItemId="toast:ffffffff-ffff-4fff-8fff-ffffffffffff:"+itemGuid;
  await expect(applyPublishedToastCatalogReceipt(
   {rpc} as unknown as SupabaseClient,business,cross)).rejects
    .toThrow("wrong_restaurant_catalog_item");
  const crossModifier=payload();
  crossModifier.items[0].modifierGroups[0].options[0].posModifierId=
   "toast:ffffffff-ffff-4fff-8fff-ffffffffffff:"+modifierGuid;
  await expect(applyPublishedToastCatalogReceipt(
   {rpc} as unknown as SupabaseClient,business,crossModifier)).rejects
    .toThrow("wrong_restaurant_catalog_modifier");
  expect(rpc).not.toHaveBeenCalled();
 });
 it("rejects absent staged facts and missing receipts before declaring provider unpublish",async()=>{
  const rpc=vi.fn(),missing=payload();
  missing.facts=[];
  await expect(applyPublishedToastCatalogReceipt(
   {rpc} as unknown as SupabaseClient,business,missing)).rejects
    .toThrow("incomplete_verified_toast_publication");
  const bad={...payload(),receipt:{...receipt,observedAt:"not-a-date"}};
  await expect(applyPublishedToastCatalogReceipt(
   {rpc} as unknown as SupabaseClient,business,bad)).rejects
    .toThrow("incomplete_verified_toast_publication");
  expect(rpc).not.toHaveBeenCalled();
 });
 it("does not claim success when the guarded SQL rejects stale copied source version",async()=>{
  const rpc=vi.fn().mockResolvedValue({data:null,
   error:{code:"22023",message:"Stale menu version"}});
  await expect(applyPublishedToastCatalogReceipt(
   {rpc} as unknown as SupabaseClient,business,payload()))
   .rejects.toMatchObject({code:"22023"});
  expect(rpc).toHaveBeenCalledOnce();
 });
});
