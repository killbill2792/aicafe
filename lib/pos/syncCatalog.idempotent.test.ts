import {describe,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {PosAdapter,PosCatalogItem} from "./types";
vi.mock("server-only",()=>({}));
import {syncCanonicalCatalog} from "./syncCatalog";

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
