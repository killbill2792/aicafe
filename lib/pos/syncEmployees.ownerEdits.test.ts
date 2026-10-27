import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {PosAdapter,PosEmployee} from "./types";
vi.mock("server-only",()=>({}));
import {syncCanonicalEmployees} from "./syncEmployees";

const business="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const employeeId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const guid="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const posId="toast:"+business+":"+guid;
type Row={
 id:string;display_name:string;pos_team_member_id:string|null;role:string|null;
 active:boolean;default_hourly_wage_cents:number|null;pos_display_name:string|null;
 pos_last_role:string|null;pos_last_wage_cents:number|null;pos_last_active:boolean|null;
};
function fixture(rows:Row[]){
 const writes:Record<string,unknown>[]=[];
 const db={from(table:string){
  const filters:Record<string,unknown>={};
  const q={
   select:()=>q,eq:(key:string,value:unknown)=>{filters[key]=value;return q;},
   is:()=>q,
   async then(resolve:(value:unknown)=>unknown){
    return resolve({data:table==="employees"?rows:null,error:null});
   },
   async update(values:Record<string,unknown>){
    writes.push({...values});
    if(table==="employees"){
     const target=rows.find(r=>r.id===filters.id);
     if(target)Object.assign(target,values);
    }
    return {error:null};
   },
   async upsert(){return {error:null};},
  };
  return q;
 }};
 return {db:db as unknown as SupabaseClient,writes,rows};
}
function manual(name:string,active=true):Row{
 return {id:employeeId,display_name:name,pos_team_member_id:null,role:"Lead",
  active,default_hourly_wage_cents:2400,pos_display_name:null,
  pos_last_role:null,pos_last_wage_cents:null,pos_last_active:null};
}
function adapter(name:string):PosAdapter{
 return {provider:"toast",fetchEmployees:async()=>[{
  posTeamMemberId:posId,displayName:name,posName:name,role:"Barista",
  hourlyWageCents:1900,active:true
 } satisfies PosEmployee]} as unknown as PosAdapter;
}
describe("shared POS roster preserves owner-managed staff",()=>{
 it("links an existing manual name without replacing its formatting, role or wage",async()=>{
  const f=fixture([manual(" María   Lopez ")]);
  const result=await syncCanonicalEmployees(f.db,business,adapter("María Lopez"));
  expect(result).toMatchObject({created:0,linked:1,review:0});
  expect(f.rows[0]).toMatchObject({pos_team_member_id:posId,
   display_name:" María   Lopez ",role:"Lead",default_hourly_wage_cents:2400});
 });
 it("does not reactivate an owner-disabled manual employee on first link",async()=>{
  const f=fixture([manual("María Lopez",false)]);
  await syncCanonicalEmployees(f.db,business,adapter("María Lopez"));
  expect(f.rows[0].active).toBe(false);
 });
});
