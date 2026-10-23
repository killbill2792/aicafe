import {describe,expect,it,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const fake=vi.hoisted(()=>({calls:[] as string[],queries:[] as Array<{table:string;operation:string;from?:number;to?:number;ids?:string[]}>}));
vi.mock("@/lib/access/access.server",()=>({accessCodeHash:()=> "hash"}));
vi.mock("@/lib/supabase/admin",()=>{
 const code={id:"c1",code_hint:"CAFE…",duration_months:3,fixed_end_date:null,max_cafes:1000,
  note:null,active:true,created_at:"2026-10-23"};
 const history={code_id:"c2",business_id:"b1",redeemed_by:null,
  redeemed_at:"2026-10-23",access_end:"2027-01-23"};
 type Query={
  order:(field:string)=>Query;
  range:(from:number,to:number)=>Promise<{data:unknown[];error:null;count:number}>;
  limit:(count:number)=>Promise<{data:unknown[];error:null}>;
  in:(field:string,ids:string[])=>Promise<{data:unknown[];error:null}>;
 };
 function query(table:string):Query{
  return {
   order:(_field:string)=>query(table),
   range:async(from:number,to:number)=>{
    fake.queries.push({table,operation:"range",from,to});
    return {data:table==="free_access_codes"?[code]:
      table==="businesses"?[{id:"b1251",name:"Last café"}]:[],error:null,
      count:table==="free_access_codes"?900:1300};
   },
   limit:async(_n:number)=>{
    fake.queries.push({table,operation:"limit"});
    return {data:table==="free_access_redemptions"?[history]:[],error:null};
   },
   in:async(_field:string,ids:string[])=>{
    fake.queries.push({table,operation:"in",ids});
    return {data:table==="cafe_access"?
      [{business_id:"b1251",mode:"paused",code_id:null,access_end:null},
       {business_id:"b1",mode:"code",code_id:"c2",access_end:"2027-01-23"}].filter(a=>ids.includes(a.business_id)):
      table==="businesses"?[{id:"b1",name:"History café"}].filter(a=>ids.includes(a.id)):
      table==="free_access_codes"?[{id:"c2",code_hint:"HISTORY…"}].filter(a=>ids.includes(a.id)):[],
      error:null};
   },
  };
 }
 return {createAdminSupabaseClient:()=>({
  from:(table:string)=>({select:()=>query(table)}),
  rpc:async(name:string)=>{fake.calls.push(name);return {data:{c1:750},error:null};},
  auth:{admin:{getUserById:async()=>({data:{user:{email:"owner@example.com"}}})}},
 })};
});
import {getAdminCodeConsole} from "./adminCodes.server";
beforeEach(()=>{fake.calls=[];fake.queries=[];});
describe("admin console maintains authoritative counts and independent café paging",()=>{
 it("keeps capacity counts separate from limited redemption history",async()=>{
  const data=await getAdminCodeConsole();
  expect(data.redemptions).toHaveLength(1);
  expect(data.codes[0].redeemed_cafes).toBe(750);
  expect(data.codeTotal).toBe(900);
  expect(data.cafeTotal).toBe(1300);
  expect(fake.calls).toContain("admin_code_redemption_counts");
 });
 it("paginates beyond 1,000 cafés with matching access rows, not a truncated arbitrary set",async()=>{
  const data=await getAdminCodeConsole(0,25);
  expect(data.cafePage).toBe(25);
  expect(data.cafes).toEqual([{id:"b1251",name:"Last café"}]);
  expect(data.access.find(a=>a.business_id==="b1251")).toMatchObject({mode:"paused"});
  expect(fake.queries).toContainEqual({table:"businesses",operation:"range",from:1250,to:1299});
  expect(fake.queries.some(q=>q.table==="cafe_access"&&q.operation==="in"&&
    q.ids?.includes("b1251"))).toBe(true);
  expect(fake.queries.some(q=>q.table==="cafe_access"&&q.operation==="limit")).toBe(false);
 });
 it("resolves ledger names, hints and access beyond the current café/code pages",async()=>{
  const data=await getAdminCodeConsole(1,25);
  expect(data.redemptions[0]).toMatchObject({business_id:"b1",cafeName:"History café",
    codeHint:"HISTORY…",access_end:"2027-01-23"});
  expect(data.access.find(a=>a.business_id==="b1")).toMatchObject({mode:"code"});
  expect(fake.queries).toContainEqual({table:"free_access_codes",operation:"range",from:50,to:99});
  expect(fake.queries).toContainEqual({table:"businesses",operation:"range",from:1250,to:1299});
 });
});
